'use strict';

const MUSE_SERVICE = 0xfe8d;

// Since the characteristics uuids listed on the muse band s seem to be identical
// to older versions of the band, we can simply use the same uuids.
// Some of these values are copied from https://github.com/urish/muse-js/blob/master/src/muse.ts
// Also I found https://articles.jaredcamins.com/figuring-out-bluetooth-low-energy-part-2-750565329a7d
// which describes some additional characteristics.
// An even more detailed list of characterstics can be found at:
// https://github.com/digital-cinema-arts/misc-tools/blob/master/test_gatt.py
const CHARACTERISTICS = {
  // This is also called STREAM_TOGGLE in other people's code.
  CONTROL: '273e0001-4c4d-454d-96be-f03bac821358',
  // What does 0002 do?
  EEG_TP9: '273e0003-4c4d-454d-96be-f03bac821358',
  EEG_AF7: '273e0004-4c4d-454d-96be-f03bac821358',
  EEG_AF8: '273e0005-4c4d-454d-96be-f03bac821358',
  EEG_TP10: '273e0006-4c4d-454d-96be-f03bac821358',
  EEG_RIGHT_AUX: '273e0007-4c4d-454d-96be-f03bac821358',

  DRL_REF: '273e0008-4c4d-454d-96be-f03bac821358',
  GYROSCOPE: '273e0009-4c4d-454d-96be-f03bac821358',
  ACCELEROMETER: '273e000a-4c4d-454d-96be-f03bac821358',
  TELEMETRY: '273e000b-4c4d-454d-96be-f03bac821358',
};

const COMMANDS = {
  START: 's',
  RESUME: 'd',
  PAUSE: 'h',
  // See https://web.archive.org/web/20190513075316/http://dev.choosemuse.com/hardware-firmware/headband-configuration-presets
  PRESET_20: 'p20', // Include eeg right aux.
  PRESET_21: 'p21', // Exclude eeg right aux.
  // It's unclear what the difference between the last 2 presets is.
  PRESET_22: 'p22',
  PRESET_23: 'p23',
};


/**
 * Handles everything related to bluetooth and the muse s headband.
 */
class MuseS {
  constructor(log, navigator) {
    this.log = log;
    this.parser = new Parser();
    this.bluetooth = false;
    this.device = false;
    this.navigator = navigator;

    this.setupBluetooth();

    this.buttons = {
      scan: document.querySelector('#scan'),
      disconnect: document.querySelector('#disconnect'),
      start: document.querySelector('#start'),
      pause: document.querySelector('#pause'),
    };
    this.setupEventHandlers();
  }

  setupBluetooth() {
    if (!this.isWebBluetoothEnabled()) {
      this.log.setStatus('Web Bluetooth API is not available.\n' +
        'Please make sure the "Experimental Web Platform features" flag is enabled.');
      return false;
    }

    this.bluetooth = this.navigator.bluetooth;
  }

  isWebBluetoothEnabled() {
    if (navigator.bluetooth) {
      return true;
    }
    else {
      return false;
    }
  }

  scanAndConnect() {
    this.log.log('Requesting Bluetooth Device...');
    return this.bluetooth.requestDevice({
      filters: [{
        name: 'MuseS-36B3',
      }],
    })
      .then(device => {
        return this.connect(device);
      })
      .catch(error => {
        this.log.log('Argh! ' + error);
      });
  }

  connect(device) {
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', (event) => this.onDisconnected(event));

    this.log.log('Connecting to bluetooth device...');
    return this.device.gatt.connect()
      .then((server) => {
        this.server = server
        this.log.log('> Bluetooth device connected.');
        return this.server.getPrimaryService(MUSE_SERVICE);
      })
      .then((service) => {
        this.service = service
        this.onConnected()
      });
  }

  // We successfully connected to the devices.
  onConnected() {
    this.buttons.disconnect.removeAttribute('disabled');
    this.buttons.start.removeAttribute('disabled');
  }

  onDisconnected(event) {
    // Object event.target is Bluetooth Device getting disconnected.
    this.log.log('> Bluetooth device disconnected');
    this.buttons.start.setAttribute('disabled', 'disabled');
    this.buttons.pause.setAttribute('disabled', 'disabled');
    this.buttons.disconnect.setAttribute('disabled', 'disabled');
  }

  onStarted(event) {
    this.buttons.start.setAttribute('disabled', 'disabled');
    this.buttons.pause.removeAttribute('disabled');
  }

  onPaused(event) {
    this.buttons.start.removeAttribute('disabled');
    this.buttons.pause.setAttribute('disabled', 'disabled');
  }

  setupEventHandlers() {
    this.buttons.scan.addEventListener('click', () => {
      this.log.clearLog();
      this.scanAndConnect()
    });

    this.buttons.disconnect.addEventListener('click', () => {
      if (this.device) {
        this.device.gatt.disconnect();
      }
      else {
        this.log.log('> Bluetooth device was not connected.');
      }
    });

    this.buttons.start.addEventListener('click', () => {
      this.setupDataCharacteristicsEventHandlers();
      this.start();
    });

    this.buttons.pause.addEventListener('click', () => {
      this.pause();
    });
  }

  setupDataCharacteristicsEventHandlers() {
    const ignored_characteristics = [
      'CONTROL',
    ];
    for (const characteristic_name in CHARACTERISTICS) {
      // Only handle characteristics we care about.
      if (ignored_characteristics.indexOf(characteristic_name) >= 0) {
        continue;
      }
      this.service.getCharacteristic(CHARACTERISTICS[characteristic_name])
        .then(characteristic => characteristic.startNotifications())
        .then(characteristic => {
          characteristic.addEventListener('characteristicvaluechanged', (event) => {
            this.onCharacteristicValueChanged(CHARACTERISTICS[characteristic_name], event)
          })
        })
    }
  }

  start() {
    this.service.getCharacteristic(CHARACTERISTICS.CONTROL)
      .then(characteristic => {
        this.controlCharacteristic = characteristic
        // Note that the band has presets, that seem to define which data is
        // available.
        // At https://web.archive.org/web/20190513075316/http://dev.choosemuse.com/hardware-firmware/headband-configuration-presets
        // there is some information about this.
        // In https://github.com/urish/muse-js/blob/master/src/muse.ts on line 131
        // it's clear that the author knows about the presets.

        // The preset can be set before starting + resuming.
        // Also note that both start and resume are necessary to make the band
        // transmit data.
        characteristic.writeValue(this.getCommand('PRESET_20'));
        characteristic.writeValue(this.getCommand('START'));
        characteristic.writeValue(this.getCommand('RESUME'));
        this.onStarted();
      })
  }

  pause() {
    this.service.getCharacteristic(CHARACTERISTICS.CONTROL)
      .then(characteristic => {
        this.controlCharacteristic = characteristic
        characteristic.writeValue(this.getCommand('PAUSE'));
        this.onPaused();
      })
  }

  getCommand(name) {
    return this.encodeCommand(COMMANDS[name]);
  }

  // Shamelessly copied from https://github.com/urish/muse-js/blob/master/src/muse.ts
  encodeCommand(cmd) {
    const encoded = new TextEncoder().encode(`X${cmd}\n`);
    encoded[0] = encoded.length - 1;
    return encoded;
  }

  onCharacteristicValueChanged(uuid, event) {
    let data;
    switch (uuid) {
      case CHARACTERISTICS.GYROSCOPE:
        data = this.parser.parseGyroscope(event.target.value);
        // Note that each data objects contains an array of 3 samples in
        // data.samples, each with their x, y and z values.
        this.log.log('> Gyroscope', data.samples[0]);
        break;

      case CHARACTERISTICS.ACCELEROMETER:
        data = this.parser.parseAccelerometer(event.target.value);
        //this.log.log('> Accelerometer', data);
        break;

      case CHARACTERISTICS.TELEMETRY:
        // This contains general data about the devices, like battery state.
        data = this.parser.parseTelemetry(event.target.value);
        //this.log.log('> Telemetry', data);
        break;

      case CHARACTERISTICS.DRL_REF:
        // It's unclear to me what this data means, since I don't know what
        // dlr ref is.
        // This data needs to be transformed to be visible in log.log.
        // Console.log shows what it really is:
        //console.log(event.target.value)

        //this.log.log('> DLR Ref', event.target.value);
        break;

      case CHARACTERISTICS.EEG_AF7:
        data = this.parser.decodeEEGSamples(new Uint8Array(event.target.value.buffer).subarray(2))
        //this.log.log('> AF7', event.target.value, data);
        break;

      case CHARACTERISTICS.EEG_AF8:
        data = this.parser.decodeEEGSamples(new Uint8Array(event.target.value.buffer).subarray(2))
        //this.log.log('> AF8', event.target.value, data);
        break;

      case CHARACTERISTICS.EEG_TP9:
        data = this.parser.decodeEEGSamples(new Uint8Array(event.target.value.buffer).subarray(2))
        //this.log.log('> TP9', event.target.value, data);
        break;

      case CHARACTERISTICS.EEG_TP10:
        data = this.parser.decodeEEGSamples(new Uint8Array(event.target.value.buffer).subarray(2))
        //this.log.log('> TP10', event.target.value, data);
        break;

      case CHARACTERISTICS.EEG_RIGHT_AUX:
        data = this.parser.decodeEEGSamples(new Uint8Array(event.target.value.buffer).subarray(2))
        //this.log.log('> Right aux', event.target.value, data);
        break;

      default:
        console.log('> Unknown data: ' + uuid, event.target.value);
    }
  }
}

class Logging {

  constructor() {
    this.logEl = document.querySelector('#log');
    this.statusEl = document.querySelector('#status');
  }

  log() {
    const line = Array.prototype.slice.call(arguments).map(function(argument) {
      return typeof argument === 'string' ? argument : JSON.stringify(argument);
    }).join(' ');
    this.logEl.textContent += line + '\n';
  }

  clearLog() {
    this.logEl.textContent = '';
  }

  setStatus(status) {
    this.statusEl.textContent = status;
  }
}


// This is straight copied from
// https://github.com/urish/muse-js/blob/master/src/lib/muse-parse.ts
// and ported to regular javascript.
class Parser {

  decodeUnsigned12BitData(samples) {
    const samples12Bit = [];
    // tslint:disable:no-bitwise
    for (let i = 0; i < samples.length; i++) {
      if (i % 3 === 0) {
        samples12Bit.push(samples[i] << 4 | samples[i + 1] >> 4);
      } else {
        samples12Bit.push((samples[i] & 0xf) << 8 | samples[i + 1]);
        i++;
      }
    }
    // tslint:enable:no-bitwise
    return samples12Bit;
  }

  decodeEEGSamples(samples) {
    return this.decodeUnsigned12BitData(samples)
      .map((n) => 0.48828125 * (n - 0x800));
  }

  parseTelemetry(data) {
    // tslint:disable:object-literal-sort-keys
    return {
      sequenceId: data.getUint16(0),
      batteryLevel: data.getUint16(2) / 512.,
      fuelGaugeVoltage: data.getUint16(4) * 2.2,
      // Next 2 bytes are probably ADC millivolt level, not sure
      temperature: data.getUint16(8),
    };
    // tslint:enable:object-literal-sort-keys
  }

  sampleImuReading(data, startIndex, scale) {
    return {
      x: scale * data.getInt16(startIndex),
      y: scale * data.getInt16(startIndex + 2),
      z: scale * data.getInt16(startIndex + 4),
    };
  }

  parseImuReading(data, scale) {
    return {
      sequenceId: data.getUint16(0),
      samples: [
        this.sampleImuReading(data, 2, scale),
        this.sampleImuReading(data, 8, scale),
        this.sampleImuReading(data, 14, scale),
      ],
    };
  }

  parseAccelerometer(data) {
    return this.parseImuReading(data, 0.0000610352);
  }

  parseGyroscope(data) {
    return this.parseImuReading(data, 0.0074768);
  }
}
