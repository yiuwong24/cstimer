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
		var connectTimeout = null;

	function updateRetryButton(state) {
		var btn = $('#bt-center-retry-btn');
		if (btn.length === 0) {
			btn = $('<button id="bt-center-retry-btn" style="display:block;margin:12px auto 4px auto;padding:8px 22px;color:#fff;border:none;border-radius:20px;font-size:15px;font-weight:bold;box-shadow:0 3px 10px rgba(0,0,0,0.45);cursor:pointer;white-space:nowrap;position:relative;z-index:9999;"></button>');
			btn.on('click', function(e) {
				e.stopPropagation();
				e.preventDefault();
				
				// 1. 清除舊的超時計時器
				if (connectTimeout) {
					clearTimeout(connectTimeout);
					connectTimeout = null;
				}

				// 2. 立即更新按鈕為「重設中...」
				btn.css({ background: '#f57c00', opacity: '1' }).text('⏳ 正在重設藍牙...');

				// 3. 安全斷開舊連線，避免直接覆蓋導致瀏覽器藍牙卡死
				try {
					if (_device && _device.gatt && _device.gatt.connected) {
						_device.gatt.disconnect();
					}
				} catch (err) {}
				_device = null;

				// 4. 直接發起新的掃描連線（必須在 click 事件內同步觸發 requestDevice，不能放進 setTimeout 否則會被瀏覽器擋掉）
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

		btn.prop('disabled', false).show();

		if (state === 'connecting') {
			btn.css({ background: '#f57c00', opacity: '1' })
			   .text('⏳ 連線中... (點擊可重試)');
		} else if (state === 'connected') {
			btn.css({ background: '#2e7d32', opacity: '0.65' })
			   .text('✓ 藍牙已連線 (點擊可重連)');
		} else {
			btn.css({ background: '#1a73e8', opacity: '1' })
			   .text('↻ 連接 / 重試藍牙');
		}
	}


	$(function() {
		setTimeout(function() {
			updateRetryButton('disconnected');
		}, 500);
	});

	function onHardwareEvent(info, event) {
		var res = Promise.resolve();
		if (info == 'disconnect') {
			res = Promise.resolve(stop(true)).then(function () {
				updateRetryButton(true);
			});
		}
		return res.then(function () {
			return typeof evtCallback == 'function' && evtCallback(info, event);
		});
	}

	var onDisconnect = onHardwareEvent.bind(null, 'disconnect');

	function init(reconnect) {
		updateRetryButton('connecting');
		if (connectTimeout) {
			clearTimeout(connectTimeout);
		}

		// 設定 10 秒超時保護：如果選完設備後 GATT 握手卡死無回應，自動恢復按鈕為可重試狀態
		var isFinished = false;
		connectTimeout = setTimeout(function() {
			if (!isFinished) {
				giikerutil.log('[bluetooth]', 'connection timeout');
				if (_device && _device.gatt && _device.gatt.connected) {
					try { _device.gatt.disconnect(); } catch (e) {}
				}
				_device = null;
				updateRetryButton('disconnected');
			}
		}, 10000);

		return giikerutil.chkAvail().then(function() {
			if (_device && reconnect) {
				return waitUntilDeviceAvailable(_device);
			}
			// 略過掃描與連線裝置建立流程 (完整程式碼請參照專案設定)
			// ...
		}).then(function(res) {
			isFinished = true;
			clearTimeout(connectTimeout);
			updateRetryButton('connected');
			return res;
		}).catch(function(err) {
			isFinished = true;
			clearTimeout(connectTimeout);
			updateRetryButton('disconnected');
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
	var State = {
		DISCONNECT: 0, GET_SET: 1, HANDS_OFF: 2, RUNNING: 3, STOPPED: 4,
		IDLE: 5, HANDS_ON: 6, FINISHED: 7, INSPECTION: 8, GAN_RESET: 9
	};
	return State;
})();
