import { Service, PlatformAccessory, CharacteristicValue, HAPStatus } from 'homebridge';
import { EightSleepThermostatPlatform } from './platform';
import { tempMapper, TwoWayTempMapper } from './twoWayTempMapper';
import { AccessoryClientAdapter, PlatformClientAdapter } from './clientAdapter';

export class EightSleepThermostatAccessory {
  private service: Service;
  private readonly log = this.platform.log;

  // Minstep calculated based on temp mapping of °C & °F locally,
  // and to ensure precision when converting between degrees/levels
  // when updating and fetching from client API.
  //
  // Since minstep slightly greater than 0.5, max temp allowed needs
  // to be greater than 45 (i.e. 45.1) to ensure we can set the temp
  // to the max on accessory in Home app (displayed as 113°F & 45°C).
  private minStep = 0.55556;
  private minTempC = 10;
  private maxTempC = 45.1;

  private Thermostat_data: Record<string, CharacteristicValue> = {
    CurrentHeatingCoolingState: 0,
    TargetHeatingCoolingState: 0,
    CurrentTemperature: 0,
    TargetTemperature: 0,
    TemperatureDisplayUnits: 1,
  };

  private tempMapper: TwoWayTempMapper = tempMapper;
  private userIdForSide = this.accessory.context.device.userId as string;
  private deviceSide = this.accessory.context.device.side as string;

  // Used to update device settings, specific to each accessory
  private accessoryClient: AccessoryClientAdapter;

  constructor(
    private readonly platform: EightSleepThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    // PlatformClientAdapter used to fetch device info, shared between accessories
    // since the device info for both sides is returned from single call to API
    private readonly platformClient: PlatformClientAdapter,
    private isNotResponding: boolean = false,
  ) {
    this.log.debug('Accessory Context:', this.accessory.context);

    this.accessoryClient = new AccessoryClientAdapter(this.accessory.context.device.userId, this.log);

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
      .setProps({ minStep: this.minStep, minValue: this.minTempC, maxValue: this.maxTempC });

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onSet(this.handleTargetTemperatureSet.bind(this))
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .setProps({ minStep: this.minStep, minValue: this.minTempC, maxValue: this.maxTempC });

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this))
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this));
  }

  /**
   * Gets the *measured* current temperature of each side of bed from
   * client API. This metric is returned from client for both sides
   * of bed from the same endpoint. In order to prevent multiple
   * unecessary requests to the same endpoint for each side of bed,
   * we query API once and parse the data using the 'side' property
   */
  private async fetchCurrentTemp() {
    const currentMeasuredLevel = await this.platformClient.currentLevelForSide(this.deviceSide as 'left' | 'right');
    const currentC = this.tempMapper.levelToCelsius(currentMeasuredLevel);
    this.Thermostat_data.CurrentTemperature = currentC;
    return currentC;
  }

  private async fetchTargetState() {
    const accessoryIsOn = await this.accessoryClient.accessoryIsOn();
    const targetState = accessoryIsOn ? 3 : 0;
    this.Thermostat_data.TargetHeatingCoolingState = targetState;
    return targetState;
  }

  private async fetchTargetTemp() {
    const targetLevel = await this.accessoryClient.userTargetLevel();
    const targetC = this.tempMapper.levelToCelsius(targetLevel);
    this.Thermostat_data.TargetTemperature = targetC;
    return targetC;
  }

  private async fetchCurrentState() {
    await Promise.all([
      this.fetchCurrentTemp(),
      this.fetchTargetState(),
      this.fetchTargetTemp(),
    ]);
    const currStateValue = this.triggerCurrentHeatingCoolingStateUpdate();
    return currStateValue;
  }

  private async updateTargetTemperature(newValue: CharacteristicValue) {
    const targetC = this.tempMapper.formatCelsius(newValue as number);
    const targetLevel = this.tempMapper.celsiusToLevel(targetC);

    if (!targetLevel || targetLevel > 100 || targetLevel < -100) {
      this.log.error('Something went wrong calculating new bed temp:', targetLevel);
      return targetC;
    }
    const clientTargetLevel = await this.accessoryClient.updateUserTargetLevel(targetLevel);
    const clientTargetC = this.tempMapper.levelToCelsius(clientTargetLevel);
    this.Thermostat_data.TargetTemperature = clientTargetC;

    if (targetC !== clientTargetC || targetLevel !== clientTargetLevel) {
      const expectation = `${targetC}°C / ${targetLevel} level`;
      const received = `${clientTargetC}°C / ${clientTargetLevel} level`;
      this.log.error(`Local/remote temp mismatch. Expected: ${expectation}, but got: ${received}`);
    }
    return clientTargetC;
  }


  // Current Temperature & State Handlers
  async handleCurrentHeatingCoolingStateGet() {
    this.ensureDeviceResponsiveness();
    const currentState = await this.fetchCurrentState();
    this.log.debug('GET CurrentHeatingCoolingState', currentState);
    return currentState;
  }

  async handleCurrentTemperatureGet() {
    this.ensureDeviceResponsiveness();
    const currTemp = await this.fetchCurrentTemp();
    this.log.debug('GET CurrentTemperature', currTemp);
    return currTemp;
  }

  // Target Temperature & State Handlers
  async handleTargetTemperatureGet() {
    this.ensureDeviceResponsiveness();
    const targetTemp = await this.fetchTargetTemp();
    this.log.debug('GET TargetTemperature', targetTemp);
    return targetTemp;
  }

  async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.ensureDeviceResponsiveness();
    const newTemp = await this.updateTargetTemperature(value);
    this.log.debug('SET TargetTemperature:', newTemp);
    this.triggerCurrentHeatingCoolingStateUpdate();
  }

  async handleTargetHeatingCoolingStateGet() {
    this.ensureDeviceResponsiveness();
    const targetState = await this.fetchTargetState();
    this.log.debug('GET TargetHeatingCoolingState', targetState);
    return targetState;
  }

  async handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.ensureDeviceResponsiveness();
    // Send request to Eight Sleep Client to update current state (only if value has changed)
    if (this.Thermostat_data.TargetHeatingCoolingState !== value) {
      this.updateDeviceState(value);
    }
    this.Thermostat_data.TargetHeatingCoolingState = value as number;
    this.log.debug('SET TargetHeatingCoolingState:', value);
    this.triggerCurrentHeatingCoolingStateUpdate();
  }

  // Temperature Display Units Handlers
  async handleTemperatureDisplayUnitsGet() {
    this.ensureDeviceResponsiveness();
    const tempUnits = this.Thermostat_data.TemperatureDisplayUnits;
    this.log.debug('GET TemperatureDisplayUnits', tempUnits);
    return tempUnits;
  }

  async handleTemperatureDisplayUnitsSet(value: CharacteristicValue) {
    this.ensureDeviceResponsiveness();
    this.Thermostat_data.TemperatureDisplayUnits = value as number;
    this.log.debug('SET TemperatureDisplayUnits:', value);
  }

  // Adjust equality comparison to account for the `minStep` property
  // of 0.5 on Target temp. Ensures that display temps are actually
  // equal when determining the current state. If target state is set
  // to `on` (`Auto`, `Cool`, `Heat`), then current state will display
  // `Idle` in home status when temps are equal.
  tempsAreEqual(current: number, target: number) {
    const diff = Math.abs(target - current);
    return (diff <= 0.55);
  }

  // Pushes changes to Current(Temp/State) via `updateCharacteristic()`
  // method. Called whenever Target(Temp/HeatingCoolingState) is changed
  // by a `set` Characteristic handler.
  private triggerCurrentHeatingCoolingStateUpdate() {
    const currTemp = this.Thermostat_data.CurrentTemperature as number;
    const targetTemp = this.Thermostat_data.TargetTemperature as number;

    if (this.tempsAreEqual(currTemp, targetTemp) || this.Thermostat_data.TargetHeatingCoolingState === 0) {
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

    this.log.debug('Update CurrentState:', this.Thermostat_data.CurrentHeatingCoolingState);
    return this.Thermostat_data.CurrentHeatingCoolingState;
  }

  private async updateDeviceState(newValue: CharacteristicValue) {
    if (newValue === 3) {
      this.log.warn('Turning on device ->', this.userIdForSide);
      this.accessoryClient.turnOnAccessory();
    } else if (newValue === 0) {
      this.accessoryClient.turnOffAccessory();
      this.log.warn('Turning off device ->', this.userIdForSide);
    }
  }

  private ensureDeviceResponsiveness() {
    if (this.isNotResponding) {
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

}