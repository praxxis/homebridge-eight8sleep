import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { EightSleepConnection } from './eightSleepConnection';
import { EightSleepThermostatPlatform } from './platform';
import { tempMapper, TwoWayTempMapper } from './twoWayTempMapper';

export class EightSleepThermostatAccessory {
  private service: Service;
  private readonly log = this.platform.log;

  private minTemp = 10;
  private maxTemp = 45;

  private Thermostat_data: Record<string, CharacteristicValue> = {
    CurrentHeatingCoolingState: 0,
    TargetHeatingCoolingState: 0,
    CurrentTemperature: 34,
    TargetTemperature: 26,
    TemperatureDisplayUnits: 1,
  };

  private tempMapper: TwoWayTempMapper = tempMapper;
  private userIdForSide = this.accessory.context.device.userId as string;

  constructor(
    private readonly platform: EightSleepThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: EightSleepConnection,
  ) {

    this.log.debug('Accessory Context:', this.accessory.context);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eight Sleep')
      .setCharacteristic(this.platform.Characteristic.Model, 'Pod Pro')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this))
      .setProps({ validValues: [
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT,
        this.platform.Characteristic.CurrentHeatingCoolingState.COOL ]});

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this))
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .setProps({ validValues: [
        this.platform.Characteristic.TargetHeatingCoolingState.OFF,
        this.platform.Characteristic.TargetHeatingCoolingState.AUTO ]});

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this))
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp });

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onSet(this.handleTargetTemperatureSet.bind(this))
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .setProps({ minStep: 0.5, minValue: this.minTemp, maxValue: this.maxTemp });

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this))
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this));

    this.fetchDeviceStatus();
  }

  async fetchDeviceStatus() {
    const deviceIsOn = await this.client.deviceIsOn(this.userIdForSide);
    const targetState = deviceIsOn ? 3 : 0;
    this.Thermostat_data.TargetHeatingCoolingState = targetState;
    this.log.debug('Fetched target state:', targetState);

    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);
    this.triggerCurrentHeatingCoolingStateUpdate();
  }

  // Current Temperature & State Handlers
  async handleCurrentHeatingCoolingStateGet() {
    const currentState = this.Thermostat_data.CurrentHeatingCoolingState as number;
    this.log.debug('Triggered GET CurrentHeatingCoolingState', currentState);
    return currentState;
  }

  async handleCurrentTemperatureGet() {
    const currTemp = this.Thermostat_data.CurrentTemperature;
    this.log.debug('Triggered GET CurrentTemperature', currTemp);
    return currTemp;
  }

  // Target Temperature & State Handlers
  async handleTargetTemperatureGet() {
    const targetTemp = this.Thermostat_data.TargetTemperature;
    this.log.debug('Triggered GET TargetTemperature', targetTemp);
    return targetTemp;
  }

  async handleTargetTemperatureSet(value: CharacteristicValue) {
    // Send request to Eight Sleep Client to update current state (only if value has changed)
    if (this.Thermostat_data.TargetTemperature !== value) {
      this.updateDeviceTemperature(value);
    }
    this.Thermostat_data.TargetTemperature = value as number;
    this.log.debug('Triggered SET TargetTemperature:', value);
    this.triggerCurrentHeatingCoolingStateUpdate();
  }

  async handleTargetHeatingCoolingStateGet() {
    const targetState = this.Thermostat_data.TargetHeatingCoolingState;
    this.log.debug('Triggered GET TargetHeatingCoolingState', targetState);
    return targetState;
  }

  async handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    // Send request to Eight Sleep Client to update current state (only if value has changed)
    if (this.Thermostat_data.TargetHeatingCoolingState !== value) {
      this.updateDeviceState(value);
    }
    this.Thermostat_data.TargetHeatingCoolingState = value as number;
    this.log.debug('Triggered SET TargetHeatingCoolingState:', value);
    this.triggerCurrentHeatingCoolingStateUpdate();
  }

  // Temperature Display Units Handlers
  async handleTemperatureDisplayUnitsGet() {
    const tempUnits = this.Thermostat_data.TemperatureDisplayUnits;
    this.log.debug('Triggered GET TemperatureDisplayUnits', tempUnits);
    return tempUnits;
  }

  async handleTemperatureDisplayUnitsSet(value: CharacteristicValue) {
    this.Thermostat_data.TemperatureDisplayUnits = value as number;
    this.log.debug('Triggered SET TemperatureDisplayUnits:', value);
  }

  // Pushes changes to Current(Temp/State) via `updateCharacteristic()`
  // method. Called whenever Target(Temp/HeatingCoolingState) is changed
  // by a `set` Characteristic handler.
  private async triggerCurrentHeatingCoolingStateUpdate() {
    const currTemp = this.Thermostat_data.CurrentTemperature as number;
    const targetTemp = this.Thermostat_data.TargetTemperature as number;

    if (this.Thermostat_data.TargetHeatingCoolingState === 0 || currTemp === targetTemp) {
      // If target state === 0 --> current state will display as 'Off' in Home app status
      // If target state === 1 && currTemp === targetTemp --> current state displays as 'Idle' in Home app status
      this.Thermostat_data.CurrentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;

    } else if (currTemp < targetTemp) {
      this.Thermostat_data.CurrentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;

    } else if (currTemp > targetTemp) {
      this.Thermostat_data.CurrentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    }

    // Manually push update through to speed up response time
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState,
      this.Thermostat_data.CurrentHeatingCoolingState);

    this.log.debug('Triggered Update of CurrentHeatingCoolingState:', this.Thermostat_data.CurrentHeatingCoolingState);
  }

  private async updateDeviceState(newValue: CharacteristicValue) {
    if (newValue === 3) {
      this.log.warn('Turning on Eight Sleep device -> sending request to client', this.userIdForSide);
      this.client.turnOnDevice(this.userIdForSide);
    } else if (newValue === 0) {
      this.client.turnOffDevice(this.userIdForSide);
      this.log.warn('Turning off Eight Sleep device -> sending request to client', this.userIdForSide);
    }
  }

  private async updateDeviceTemperature(newValue: CharacteristicValue) {
    const targetTemp = newValue as number;
    const targetF = Math.round(targetTemp * 9/5) + 32;
    const targetLevel = this.tempMapper.getLevelFrom(targetF);
    this.log.warn(`New target temp ${targetF}°F, client level ${targetLevel}`);
  }

}