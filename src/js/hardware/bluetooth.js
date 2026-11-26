"use strict";

function BtDeviceGroupFactory() {

	function dataViewToBytes(value) {
		var ret = [];
		for (var i = 0; i < value.byteLength; i++) {
			ret[i] = value.getUint8(i);
		}
		return ret;
	}

	function createAesCbcCodec(key, iv) {
		var decoder = $.aes128(key);
		iv = iv || [];

		function decode(value) {
			var ret = dataViewToBytes(value);
			if (ret.length > 16) {
				var offset = ret.length - 16;
				var block = decoder.decrypt(ret.slice(offset));
				for (var i = 0; i < 16; i++) {
					ret[i + offset] = block[i] ^ (~~iv[i]);
				}
			}
			decoder.decrypt(ret);
			for (var i = 0; i < 16; i++) {
				ret[i] ^= (~~iv[i]);
			}
			return ret;
		}

		function encode(ret) {
			for (var i = 0; i < 16; i++) {
				ret[i] ^= ~~iv[i];
			}
			decoder.encrypt(ret);
			if (ret.length > 16) {
				var offset = ret.length - 16;
				var block = ret.slice(offset);
				for (var i = 0; i < 16; i++) {
					block[i] ^= ~~iv[i];
				}
				decoder.encrypt(block);
				for (var i = 0; i < 16; i++) {
					ret[i + offset] = block[i];
				}
			}
			return ret;
		}

		return {
			decode: decode,
			encode: encode
		};
	}

	function crc16(data, poly, init, reflect) {
		var crc = init;
		for (var i = 0; i < data.length; i++) {
			if (reflect) {
				crc ^= data[i];
				for (var j = 0; j < 8; j++) {
					crc = (crc & 0x1) > 0 ? (crc >> 1) ^ poly : crc >> 1;
				}
			} else {
				crc ^= data[i] << 8;
				for (var j = 0; j < 8; j++) {
					crc = (crc & 0x8000) > 0 ? (crc << 1) ^ poly : crc << 1;
				}
			}
		}
		return crc & 0xFFFF;
	}

	function crc16modbus(data) {
		return crc16(data, 0xa001, 0xFFFF, true);
	}

	function crc16ccit(data) {
		return crc16(data, 0x1021, 0xFFFF, false);
	}

	/* { prefix: cubeModel } */
	var cubeModels = {};

	function regCubeModel(cubeModel) {
		if ($.isArray(cubeModel.prefix)) {
			cubeModel.prefix.map((prefix) => {
				cubeModels[prefix] = cubeModel;
			});
		} else {
			cubeModels[cubeModel.prefix] = cubeModel;
		}
	}

	var cube = undefined;
	var _device = null;

	function toUuid128(uuid) {
		if (/^[0-9A-Fa-f]{4}$/.exec(uuid)) {
			uuid = "0000" + uuid + "-0000-1000-8000-00805F9B34FB";
		}
		return uuid.toUpperCase();
	}

	function findUUID(elems, uuid) {
		uuid = toUuid128(uuid);
		for (var i = 0; i < elems.length; i++) {
			var elem = elems[i]
			if (toUuid128(elem.uuid) == uuid) {
				return elem;
			}
		}
		return null;
	}

	function waitForAdvs() {
		if (!_device || !_device.watchAdvertisements) {
			return Promise.reject(-1);
		}
		var uaPlatform = navigator.userAgentData && navigator.userAgentData.platform;
		if (uaPlatform == 'Linux' || uaPlatform == 'Chrome OS') {
			return Promise.reject(-1);
		}
		var abortController = new AbortController();
		return new Promise(function (resolve, reject) {
			var onAdvEvent = function (event) {
				giikerutil.log('[bluetooth] receive adv event', event);
				if (!event.manufacturerData || event.manufacturerData.size == 0) {
					giikerutil.log('[bluetooth] adv has no manufacturer data, waiting for next');
					return;
				}
				_device && _device.removeEventListener('advertisementreceived', onAdvEvent);
				abortController.abort();
				resolve(event.manufacturerData);
			};
			_device.addEventListener('advertisementreceived', onAdvEvent);
			_device.watchAdvertisements({ signal: abortController.signal });
			setTimeout(function () {
				_device && _device.removeEventListener('advertisementreceived', onAdvEvent);
				abortController.abort();
				reject(-2);
			}, 10000);
		});
	}
	
	function setInlineRetryBtn(show, labelText) {
		var btn = $('#bt-inline-retry-btn');
		if (show) {
			if (btn.length === 0) {
				btn = $('<button id="bt-inline-retry-btn" style="display:block;margin:10px auto 4px auto;padding:8px 22px;background:#1a73e8;color:#fff;border:none;border-radius:20px;font-size:15px;font-weight:bold;box-shadow:0 3px 10px rgba(0,0,0,0.45);cursor:pointer;white-space:nowrap;position:relative;z-index:9999;"></button>');
				btn.on('click', function (e) {
					e.stopPropagation();
					e.preventDefault();
					btn.text('⏳ 連線中...').prop('disabled', true);
					_device = null;
					init(false);
				});
				if ($('#lcd').length > 0) {
					$('#lcd').after(btn);
				} else if ($('#avgstr').length > 0) {
					$('#avgstr').before(btn);
				} else {
					$('body').append(btn);
				}
			}
			btn.text(labelText || '↻ 藍牙斷線 (點擊重連)').prop('disabled', false).show();
		} else {
			btn.hide();
		}
	}

	function onHardwareEvent(info, event) {
		var res = Promise.resolve();
		if (info == 'disconnect') {
			res = Promise.resolve(stop(true)).then(function () {
				setInlineRetryBtn(true, '↻ 計時器已斷線 (點擊重連)');
			});
		}
		return res.then(function () {
			return typeof evtCallback == 'function' && evtCallback(info, event);
		});
	}

		var onDisconnect = onHardwareEvent.bind(null, 'disconnect');

	function init(reconnect) {
		var connectTimer = null;
		setInlineRetryBtn(false);
		return giikerutil.chkAvail().then(function () {
			if (_device && reconnect) {
				giikerutil.log('[bluetooth]', 'reconnecting...', _device);
				if (!_device.watchAdvertisements) {
					return _device;
				}
				return waitUntilDeviceAvailable(_device);
			}
			var filters = Object.keys(cubeModels).map((prefix) => ({ namePrefix: prefix }));
			var opservs = [...new Set(Array.prototype.concat.apply([], Object.values(cubeModels).map((cubeModel) => cubeModel.opservs || [])))];
			var cics = [...new Set(Array.prototype.concat.apply([], Object.values(cubeModels).map((cubeModel) => cubeModel.cics || [])))];
			var servFilters = [...new Set(Array.prototype.concat.apply([], Object.values(cubeModels).map((cubeModel) => cubeModel.servFilters || [])))];
			if (!/Bluefy/i.test(window.navigator.userAgent || '')) {
				filters = filters.concat(servFilters.map((service) => ({ services: [service] })));
			}
			giikerutil.log('[bluetooth]', 'scanning...', Object.keys(cubeModels));
			return window.navigator.bluetooth.requestDevice({
				filters: filters,
				optionalServices: opservs,
				optionalManufacturerData: cics
			});
		}).then(function (device) {
			giikerutil.log('[bluetooth]', 'BLE device is selected, name=' + device.name, device);
			_device = device;
			device.addEventListener('gattserverdisconnected', onDisconnect);
			cube = null;
			var bestPrefix = '';
			for (var prefix in cubeModels) {
				if (device.name && device.name.startsWith(prefix) && prefix.length > bestPrefix.length) {
					bestPrefix = prefix;
					cube = cubeModels[prefix];
				}
			}

			var connectPromise;
			if (cube) {
				connectPromise = cube.init(device);
			} else {
				connectPromise = device.gatt.connect().then((gatt) => gatt.getPrimaryServices()).then(function (servs) {
					var uuids = servs.map((service) => toUuid128(service.uuid));
					cube = Object.values(cubeModels).find((model) => (model.servFilters || []).some((s) => uuids.indexOf(toUuid128(s)) >= 0));
					if (!cube) {
						return Promise.reject('Cannot detect device type');
					}
					return cube.init(device);
				});
			}

			var timeoutPromise = new Promise(function (_, reject) {
				connectTimer = setTimeout(function () {
					try {
						if (device && device.gatt && device.gatt.connected) {
							device.gatt.disconnect();
						}
					} catch (e) {}
					reject(new Error('連線超時 (5秒無回應)'));
				}, 5000);
			});

			return Promise.race([connectPromise, timeoutPromise]).finally(function () {
				if (connectTimer) {
					clearTimeout(connectTimer);
				}
			});
		}).then(function (res) {
			setInlineRetryBtn(false);
			return res;
		}).catch(function (err) {
			if (connectTimer) {
				clearTimeout(connectTimer);
			}
			// 如果是在 Select Device 視窗不小心按取消 (NotFoundError)，一樣顯示 Retry 按鈕，但不彈出報錯 alert
			if (err && err.name === 'NotFoundError') {
				setInlineRetryBtn(true, '↻ 未選擇設備 (點擊重新連線)');
				return;
			}
			setInlineRetryBtn(true, '↻ 連線失敗 / 超時 (點擊重試)');
			return Promise.reject(err);
		});
	}

	function waitUntilDeviceAvailable(device) {
		var abortController = new AbortController();
		return new Promise(function (resolve, reject) {
			if (!device.watchAdvertisements) {
				reject("Bluetooth Advertisements API is not supported by this browser");
			} else {
				var onAdvEvent = function (event) {
					DEBUG && console.log('[bluetooth] received advertisement packet from device', event);
					delete device.stopWaiting;
					device.removeEventListener('advertisementreceived', onAdvEvent);
					abortController.abort();
					resolve(device);
				};
				device.stopWaiting = function () {
					DEBUG && console.log('[bluetooth] cancel waiting for device advertisements');
					delete device.stopWaiting;
					device.removeEventListener('advertisementreceived', onAdvEvent);
					abortController.abort();
				}
				device.addEventListener('advertisementreceived', onAdvEvent);
				device.watchAdvertisements({ signal: abortController.signal });
				DEBUG && console.log('[bluetooth] start waiting for device advertisement packet');
			}
		});
	}

	function stop(isHardwareEvent) {
		if (!_device) {
			return Promise.resolve();
		}
		return Promise.resolve(cube && cube.clear(isHardwareEvent)).then(function () {
			_device.removeEventListener('gattserverdisconnected', onDisconnect);
			_device.gatt.disconnect();
			_device = null;
		});
	}

	var callback = $.noop;
	var evtCallback = $.noop;

	return {
		init: init,
		stop: stop,
		isConnected: function () {
			return _device != null || DEBUGBL;
		},
		setCallback: function (func) {
			callback = func;
		},
		setEventCallback: function (func) {
			evtCallback = func;
		},
		getCube: function () {
			return cube || (DEBUGBL && {
				getBatteryLevel: function () { return Promise.resolve(80); }
			});
		},
		regCubeModel: regCubeModel,
		dataViewToBytes: dataViewToBytes,
		createAesCbcCodec: createAesCbcCodec,
		crc16modbus: crc16modbus,
		crc16ccit: crc16ccit,
		findUUID: findUUID,
		waitForAdvs: waitForAdvs,
		onDisconnect: onDisconnect,
		callback: function () {
			return callback.apply(null, arguments);
		}
	};
}

var GiikerCube = execMain(BtDeviceGroupFactory);

var BluetoothTimer = execMain(BtDeviceGroupFactory);

BluetoothTimer.CONST = (function () {
	var State = {};
	State.DISCONNECT = 0;
	State.GET_SET = 1;
	State.HANDS_OFF = 2;
	State.RUNNING = 3;
	State.STOPPED = 4;
	State.IDLE = 5;
	State.HANDS_ON = 6;
	State.FINISHED = 7;
	State.INSPECTION = 8;
	State.GAN_RESET = 9;
	return State;
})();
