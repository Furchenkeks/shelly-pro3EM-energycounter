// Shelly Energiezähler Skript
// Version 1.6 - Dynamische Phase & Autarkie/Eigenverbrauch
// MODIFIZIERT: Kombiniert die einfache Phasen-Konfiguration mit der Berechnung von Autarkie & Eigenverbrauch.

// ### Konfiguration für die solare Einspeisephase ###
// Ändere diesen Wert auf 1, 2 oder 3, je nachdem, an welcher Phase der Wechselrichter angeschlossen ist.
const SOLAR_FEED_IN_PHASE = 2; // 1=Phase A (L1), 2=Phase B (L2), 3=Phase C (L3)


// Zähler für Netzbezug/-einspeisung (Gesamtwerte)
let energyReturnedWs = 0.0;
let energyConsumedWs = 0.0; // Gesamt-Netzbezug Ws
let energyReturnedKWh = 0.0;
let energyConsumedKWh = 0.0; // Gesamt-Netzbezug kWh

// Zähler für tägliche Werte
let dailyGridConsumedKWh = 0.0;
let dailyGridConsumedWs = 0.0;
let dailySolarSelfConsumptionKWh = 0.0;
let dailySolarWastedKWh = 0.0;
let dailySolarSelfConsumptionWs = 0.0;
let dailySolarWastedWs = 0.0;

// Globale Variable für aktuelle Solarleistung (gelesen aus KVS)
let currentSolarPower = 0.0; // in Watt

// KVS-Schlüssel und Intervalle
const KVS_KEY_SOLAR_POWER = "currentSolarPowerWatts";
const SOLAR_POWER_READ_INTERVAL_MS = 5000;
const DAILY_STATS_RESET_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Stündliche Prüfung für Tagesreset
let lastDayCheckedForDailyStats = -1;

// Einstellungen
let log = 1; // 0=kein Log, 1=Basis-Log, 2=Detail-Log (Empfehlung: 1 für normalen Betrieb)
let MQTTpublish = true;
let updateName = true; // Für Gerätenamen-Update

let SHELLY_ID = undefined;
Shelly.call("Mqtt.GetConfig", "", function (res, err_code, err_msg, ud) {
  if (res && res.topic_prefix) {
    SHELLY_ID = res.topic_prefix;
    if (log > 0) print("MQTT Topic Prefix (SHELLY_ID):", SHELLY_ID);
  } else if (log > 0) {
    print("MQTT Topic Prefix konnte nicht ermittelt werden. Code:", err_code, "Msg:", err_msg);
  }
});

// Konstanten
const TIMER_INTERVAL_SECONDS = 1.0;

// ### Manuelle Padding-Funktion (Ersatz für padStart) ###
function manualPadStart(str, targetLength, padString) {
  str = String(str);
  padString = String((typeof padString !== 'undefined' ? padString : ' '));
  if (str.length >= targetLength) { return str; }
  let padding = "";
  let charsToPad = targetLength - str.length;
  while (padding.length < charsToPad) { padding += padString; }
  return padding.slice(0, charsToPad) + str;
}

// ### KVS-Schreibwarteschlange ###
let kvsWriteQueue = [];
let isProcessingKVSWriteQueue = false;

function processKVSWriteQueue() {
  if (isProcessingKVSWriteQueue || kvsWriteQueue.length === 0) { return; }
  isProcessingKVSWriteQueue = true;
  let task = kvsWriteQueue[0];
  Shelly.call("KVS.Set", { "key": task.key, "value": task.value },
    function(result, error_code, error_message) {
      if (error_code !== 0 && log > 0) print("KVS.Set Fehler für Key '", task.key, "': ", error_message);
      kvsWriteQueue = kvsWriteQueue.slice(1);
      isProcessingKVSWriteQueue = false;
      processKVSWriteQueue();
    }
  );
}

function SetKVS(key, value) {
  let existingTaskIndex = -1;
  for (let i = 0; i < kvsWriteQueue.length; i++) {
    if (kvsWriteQueue[i].key === key) { existingTaskIndex = i; break; }
  }
  if (existingTaskIndex !== -1) {
    kvsWriteQueue[existingTaskIndex].value = value;
  } else {
    kvsWriteQueue.push({ "key": key, "value": value });
  }
  processKVSWriteQueue();
}

// ### Leistungsformatierung (Auto W/kW) ###
function formatPower(power) {
  if (power === null || typeof power === "undefined") return "N/A";
  if (Math.abs(power) >= 1000) { return (power / 1000).toFixed(1) + "kW"; }
  return Math.round(power) + "W";
}

function SaveAllCountersToKVS() {
  SetKVS("EnergyConsumedKWh", energyConsumedKWh.toFixed(5));
  SetKVS("EnergyReturnedKWh", energyReturnedKWh.toFixed(5));
  SetKVS("DailyGridConsumedKWh", dailyGridConsumedKWh.toFixed(5));
  SetKVS("DailySolarSelfConsumptionKWh", dailySolarSelfConsumptionKWh.toFixed(5));
  SetKVS("DailySolarWastedKWh", dailySolarWastedKWh.toFixed(5));
  SetKVS("lastDayCheckedForDailyStats", String(lastDayCheckedForDailyStats));
  if (log > 0) print("Alle Zählerstände in KVS-Queue eingereiht.");
}

// ### Laden der KVS-Werte beim Start ###
let kvsValuesToLoad = [
    { key: "EnergyReturnedKWh", callback: function(value) { energyReturnedKWh = value; } },
    { key: "EnergyConsumedKWh", callback: function(value) { energyConsumedKWh = value; } },
    { key: "DailyGridConsumedKWh", callback: function(value) { dailyGridConsumedKWh = value; } },
    { key: "DailySolarSelfConsumptionKWh", callback: function(value) { dailySolarSelfConsumptionKWh = value; } },
    { key: "DailySolarWastedKWh", callback: function(value) { dailySolarWastedKWh = value; } },
    { key: "lastDayCheckedForDailyStats", callback: function(value) {
        let parsedValue = parseInt(value); 
        if (!isNaN(parsedValue)) { lastDayCheckedForDailyStats = parsedValue; }
        else { lastDayCheckedForDailyStats = -1; }
    } }
];
function loadKVSSequentially(index) {
    if (index >= kvsValuesToLoad.length) { checkAndResetDailyStats(); return; }
    let item = kvsValuesToLoad[index];
    Shelly.call("KVS.Get", { "key": item.key }, function(result, error_code, error_message) {
        if (error_code === 0 && result && result.value !== null) {
            if (item.key !== "lastDayCheckedForDailyStats") {
                let numValue = Number(result.value);
                if (!isNaN(numValue)) { item.callback(numValue); }
            } else { item.callback(result.value); }
        } else { 
            if (item.key === "lastDayCheckedForDailyStats") { item.callback(null); }
        }
        loadKVSSequentially(index + 1);
    });
}
if (log > 0) print("Starte KVS Ladevorgang...");
loadKVSSequentially(0);

// ### Solarleistung aus KVS lesen ###
function readSolarPowerFromKVS() {
    Shelly.call("KVS.Get", { key: KVS_KEY_SOLAR_POWER }, function(result, error_code, error_message) {
        if (error_code === 0 && result && typeof result.value !== "undefined" && result.value !== null) {
            let kvsSolarVal = parseFloat(result.value);
            if (!isNaN(kvsSolarVal)) { currentSolarPower = kvsSolarVal; }
            else { currentSolarPower = 0; }
        } else { currentSolarPower = 0; }
    });
}
Timer.set(SOLAR_POWER_READ_INTERVAL_MS, true, readSolarPowerFromKVS);
readSolarPowerFromKVS(); 

// ### Täglichen Reset der Zähler prüfen und durchführen ###
function checkAndResetDailyStats() {
    let now = new Date(); let currentDay = now.getDate(); let performReset = false;
    if (lastDayCheckedForDailyStats === -1 || isNaN(lastDayCheckedForDailyStats)) { if (log > 0) print("checkAndResetDailyStats: Initialer Reset."); performReset = true; }
    else if (currentDay !== lastDayCheckedForDailyStats) { if (log > 0) print("checkAndResetDailyStats: Tageswechsel erkannt. Reset."); performReset = true; }
    if (performReset) {
        if (lastDayCheckedForDailyStats !== -1 && !isNaN(lastDayCheckedForDailyStats) && currentDay !== lastDayCheckedForDailyStats) {
            let yesterdayDateObj = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            let year = yesterdayDateObj.getFullYear();
            let month = manualPadStart(String(yesterdayDateObj.getMonth() + 1), 2, '0');
            let day = manualPadStart(String(yesterdayDateObj.getDate()), 2, '0');
            let yesterdayStr = year + "-" + month + "-" + day;
            SetKVS("GridConsumed_" + yesterdayStr + "_KWh", dailyGridConsumedKWh.toFixed(5));
            SetKVS("SolarSelfConsumption_" + yesterdayStr + "_KWh", dailySolarSelfConsumptionKWh.toFixed(5));
            SetKVS("SolarWasted_" + yesterdayStr + "_KWh", dailySolarWastedKWh.toFixed(5));
        }
        dailyGridConsumedKWh = 0.0; dailyGridConsumedWs = 0.0;
        dailySolarSelfConsumptionKWh = 0.0; dailySolarWastedKWh = 0.0;
        dailySolarSelfConsumptionWs = 0.0; dailySolarWastedWs = 0.0;
        lastDayCheckedForDailyStats = currentDay; 
        SetKVS("lastDayCheckedForDailyStats", String(lastDayCheckedForDailyStats)); 
        if (log > 0) print("Alle täglichen Zähler zurückgesetzt. Neuer Tag:", currentDay);
    }
}
Timer.set(DAILY_STATS_RESET_CHECK_INTERVAL_MS, true, checkAndResetDailyStats); 

// ### Manueller Reset der Tageszähler ###
function manualResetDailyCounters() {
  if (log > 0) print("MANUELLER RESET DER TAGESZÄHLER GESTARTET.");
  dailyGridConsumedKWh = 0.0; dailyGridConsumedWs = 0.0;
  dailySolarSelfConsumptionKWh = 0.0; dailySolarWastedKWh = 0.0;
  dailySolarSelfConsumptionWs = 0.0; dailySolarWastedWs = 0.0;
  let now = new Date(); lastDayCheckedForDailyStats = now.getDate(); 
  SaveAllCountersToKVS(); 
  if (log > 0) print("MANUELLER RESET ABGESCHLOSSEN.");
}

// ### Haupt-Timer Handler ###
let counterSaveKVS = 0;
const SAVE_KVS_INTERVAL_CYCLES = Math.round(30 * 60 / TIMER_INTERVAL_SECONDS); 
const PUBLISH_MQTT_INTERVAL_CYCLES = Math.round(10 / TIMER_INTERVAL_SECONDS); 
let counterPublishMQTT = PUBLISH_MQTT_INTERVAL_CYCLES -1;

let lastPublishedMQTTConsumedTotal = "";
let lastPublishedMQTTReturnedTotal = "";
let lastPublishedMQTTDailyGridConsumed = "";
let lastPublishedMQTTSolarSelfConsumption = "";
let lastPublishedMQTTSolarWasted = "";
let lastPublishedMQTTGridTotalWatts = "";
let lastPublishedMQTTPhaseGrossConsumption = "";
// ### NEU HINZUGEFÜGT: Variablen für Autarkie und Eigenverbrauch ###
let lastPublishedMQTTAutarkyRate = "";
let lastPublishedMQTTSelfConsumptionRate = "";

let currentGridPower_W = 0; 

function timerHandler(user_data) {
  let phase_key = "";
  if (SOLAR_FEED_IN_PHASE === 1) phase_key = "a_act_power";
  else if (SOLAR_FEED_IN_PHASE === 2) phase_key = "b_act_power";
  else if (SOLAR_FEED_IN_PHASE === 3) phase_key = "c_act_power";
  
  let em = Shelly.getComponentStatus("em", 0);
  
  if (typeof em === 'undefined' || typeof em.total_act_power === 'undefined' || (phase_key !== "" && typeof em[phase_key] === 'undefined')) {
    if (log > 0) print("Fehler: Energiemessdaten (em) nicht vollständig verfügbar.");
    return;
  }

  currentGridPower_W = em.total_act_power;
  let solar_W = currentSolarPower; 
  
  let phase_net_power_W = (phase_key !== "") ? em[phase_key] : 0;
  let phase_gross_consumption_W = phase_net_power_W + solar_W;
  
  let selfConsumptionInc_Ws = 0; let wastedInc_Ws = 0; let gridConsumedInc_Ws = 0;
  if (currentGridPower_W >= 0) { energyConsumedWs += currentGridPower_W * TIMER_INTERVAL_SECONDS; gridConsumedInc_Ws = currentGridPower_W * TIMER_INTERVAL_SECONDS; } 
  else { energyReturnedWs -= currentGridPower_W * TIMER_INTERVAL_SECONDS; }
  let houseConsumption_W = solar_W + currentGridPower_W; 
  if (solar_W > 0) { 
      if (currentGridPower_W < 0) { let netExport_W = -currentGridPower_W; selfConsumptionInc_Ws = (solar_W - netExport_W) * TIMER_INTERVAL_SECONDS; wastedInc_Ws = netExport_W * TIMER_INTERVAL_SECONDS; } 
      else { selfConsumptionInc_Ws = Math.min(solar_W, houseConsumption_W) * TIMER_INTERVAL_SECONDS; wastedInc_Ws = 0; }
  } else { selfConsumptionInc_Ws = 0; wastedInc_Ws = 0; }
  selfConsumptionInc_Ws = Math.max(0, selfConsumptionInc_Ws);
  dailyGridConsumedWs += gridConsumedInc_Ws;
  dailySolarSelfConsumptionWs += selfConsumptionInc_Ws;
  dailySolarWastedWs += wastedInc_Ws;
  let fullWhConsumed = Math.floor(energyConsumedWs / 3600); if (fullWhConsumed > 0) { energyConsumedKWh += fullWhConsumed / 1000; energyConsumedWs -= fullWhConsumed * 3600; }
  let fullWhReturned = Math.floor(energyReturnedWs / 3600); if (fullWhReturned > 0) { energyReturnedKWh += fullWhReturned / 1000; energyReturnedWs -= fullWhReturned * 3600; }
  let fullWhDailyGrid = Math.floor(dailyGridConsumedWs / 3600); if (fullWhDailyGrid > 0) { dailyGridConsumedKWh += fullWhDailyGrid / 1000; dailyGridConsumedWs -= fullWhDailyGrid * 3600; }
  let fullWhSolarSelf = Math.floor(dailySolarSelfConsumptionWs / 3600); if (fullWhSolarSelf > 0) { dailySolarSelfConsumptionKWh += fullWhSolarSelf / 1000; dailySolarSelfConsumptionWs -= fullWhSolarSelf * 3600; }
  let fullWhSolarWasted = Math.floor(dailySolarWastedWs / 3600); if (fullWhSolarWasted > 0) { dailySolarWastedKWh += fullWhSolarWasted / 1000; dailySolarWastedWs -= fullWhSolarWasted * 3600; }

  counterSaveKVS++;
  if (counterSaveKVS >= SAVE_KVS_INTERVAL_CYCLES) {
    counterSaveKVS = 0;
    SaveAllCountersToKVS();
  }

  counterPublishMQTT++;
  if (counterPublishMQTT >= PUBLISH_MQTT_INTERVAL_CYCLES) {
    counterPublishMQTT = 0;
    if (updateName) {
      let deviceName = "Akt:" + formatPower(currentGridPower_W) + " Sol:" + formatPower(currentSolarPower) + " Tag:" + dailyGridConsumedKWh.toFixed(1) + " Spar:" + dailySolarSelfConsumptionKWh.toFixed(1);
      if (deviceName.length > 63) { deviceName = deviceName.substring(0, 63); }
      Shelly.call("Sys.SetConfig", { config: { device: { name: deviceName } } });
    }
    if (typeof SHELLY_ID !== "undefined" && MQTTpublish === true) {
      // Bestehende MQTT-Publish-Anweisungen
      let valConsumedTotal = energyConsumedKWh.toFixed(3); if (valConsumedTotal !== lastPublishedMQTTConsumedTotal) { MQTT.publish(SHELLY_ID + "/energy_counter/consumed_total_kwh", valConsumedTotal, 0, false); lastPublishedMQTTConsumedTotal = valConsumedTotal; }
      let valReturnedTotal = energyReturnedKWh.toFixed(3); if (valReturnedTotal !== lastPublishedMQTTReturnedTotal) { MQTT.publish(SHELLY_ID + "/energy_counter/returned_total_kwh", valReturnedTotal, 0, false); lastPublishedMQTTReturnedTotal = valReturnedTotal; }
      let valDailyGrid = dailyGridConsumedKWh.toFixed(3); if (valDailyGrid !== lastPublishedMQTTDailyGridConsumed) { MQTT.publish(SHELLY_ID + "/energy_daily/grid_consumed_kwh", valDailyGrid, 0, false); lastPublishedMQTTDailyGridConsumed = valDailyGrid; }
      let valSolarSelf = dailySolarSelfConsumptionKWh.toFixed(3); if (valSolarSelf !== lastPublishedMQTTSolarSelfConsumption) { MQTT.publish(SHELLY_ID + "/energy_daily/solar_self_consumption_kwh", valSolarSelf, 0, false); lastPublishedMQTTSolarSelfConsumption = valSolarSelf; }
      let valSolarWasted = dailySolarWastedKWh.toFixed(3); if (valSolarWasted !== lastPublishedMQTTSolarWasted) { MQTT.publish(SHELLY_ID + "/energy_daily/solar_to_grid_kwh", valSolarWasted, 0, false); lastPublishedMQTTSolarWasted = valSolarWasted; }
      let valGridTotalWatts = currentGridPower_W.toFixed(1); if (valGridTotalWatts !== lastPublishedMQTTGridTotalWatts) { MQTT.publish(SHELLY_ID + "/power/grid_total_watts", valGridTotalWatts, 0, false); lastPublishedMQTTGridTotalWatts = valGridTotalWatts; }
      
      let phase_topic_part = "phase" + String(SOLAR_FEED_IN_PHASE);
      let valPhaseGrossConsumption = phase_gross_consumption_W.toFixed(1);
      if (valPhaseGrossConsumption !== lastPublishedMQTTPhaseGrossConsumption) {
        MQTT.publish(SHELLY_ID + "/power/" + phase_topic_part + "_gross_consumption_watts", valPhaseGrossConsumption, 0, false);
        lastPublishedMQTTPhaseGrossConsumption = valPhaseGrossConsumption;
      }
      
      // ### NEU HINZUGEFÜGT: Berechnung und Publish für Autarkie und Eigenverbrauch ###
      let total_consumption_kwh = dailyGridConsumedKWh + dailySolarSelfConsumptionKWh;
      let autarky_rate = (total_consumption_kwh > 0) ? (dailySolarSelfConsumptionKWh / total_consumption_kwh * 100) : 0;
      let valAutarky = autarky_rate.toFixed(1);
      if (valAutarky !== lastPublishedMQTTAutarkyRate) {
        MQTT.publish(SHELLY_ID + "/energy_daily/autarky_rate_percent", valAutarky, 0, false);
        lastPublishedMQTTAutarkyRate = valAutarky;
      }
      
      let total_generation_kwh = dailySolarSelfConsumptionKWh + dailySolarWastedKWh;
      let self_consumption_rate = (total_generation_kwh > 0) ? (dailySolarSelfConsumptionKWh / total_generation_kwh * 100) : 0;
      let valSelfConsumption = self_consumption_rate.toFixed(1);
      if (valSelfConsumption !== lastPublishedMQTTSelfConsumptionRate) {
        MQTT.publish(SHELLY_ID + "/energy_daily/self_consumption_rate_percent", valSelfConsumption, 0, false);
        lastPublishedMQTTSelfConsumptionRate = valSelfConsumption;
      }

      if (log > 1) print("MQTT Daten publiziert.");
    }
  }
}
Timer.set(TIMER_INTERVAL_SECONDS * 1000, true, timerHandler, null);

if (log > 0) print("Energiezaehler-Skript V1.6 (modifiziert) gestartet.");
