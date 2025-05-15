
// Energiezähler-Daten (Gesamtwerte)
var energyReturnedWs = 0.0;
var energyConsumedWs = 0.0;
var energySelfConsumedWs = 0.0;
var energyWastedWs = 0.0;

var energyReturnedKWh = 0.0;
var energyConsumedKWh = 0.0;
var energySelfConsumedKWh = 0.0;
var energyWastedKWh = 0.0;

// Tageswerte
var dailyEnergyReturnedKWh = 0.0;
var dailyEnergyConsumedKWh = 0.0;
var dailyEnergySelfConsumedKWh = 0.0;
var dailyEnergyWastedKWh = 0.0;
var lastDayChecked = -1;

// OpenDTU-Konfiguration
var OPENDTU_API_URL = "http://192.168.0.100/api/livedata/status"; // Ihre OpenDTU API URL
var OPENDTU_FETCH_INTERVAL_MS = 5000; // Abfrageintervall für OpenDTU in Millisekunden (Standard: 5 Sekunden)
var solarPower = 0.0;             // Aktuelle Solarleistung in Watt
var lastSolarUpdate = 0;          // Zeitstempel der letzten Solar-Aktualisierung

// Einstellungen
var log = 1;
var MQTTpublish = true;
var updateName = true;
var showSolarInConsole = true; // Steuert Konsolenausgabe der Solarleistung (wenn log=1)

// MQTT-Konfiguration
var SHELLY_ID = undefined;
Shelly.call("Mqtt.GetConfig", "", function(res) {
  if (res && res.topic_prefix) SHELLY_ID = res.topic_prefix;
  if (log && SHELLY_ID) print("MQTT Topic Prefix (SHELLY_ID):", SHELLY_ID);
  else if (log && !SHELLY_ID) print("MQTT Topic Prefix konnte nicht ermittelt werden.");
});

// Konstanten
var MS_PER_DAY = 24 * 60 * 60 * 1000;
var WS_PER_WH = 3600;
var WH_PER_KWH = 1000;
var WS_TO_KWH_FACTOR = 1 / WS_PER_WH / WH_PER_KWH;
var TIMER_INTERVAL_SECONDS = 0.5;
var MQTT_PUBLISH_INTERVAL_MS = 5000;  // MQTT Update alle 5 Sekunden
var KVS_SAVE_INTERVAL_MS = 20000;     // KVS Speicherung alle 20 Sekunden

// ### Kompatible KVS-Warteschlange (Key-Value Store) ###
var kvsQueue = [];
var isProcessingKVS = false;

function processKVSQueue() {
  if (isProcessingKVS || kvsQueue.length === 0) return;
  
  isProcessingKVS = true;
  var nextItem = kvsQueue[0];
  kvsQueue = kvsQueue.slice(1);
  
  Shelly.call("KVS.Set", {key: nextItem.key, value: nextItem.value}, function(result, error_code, error_message) {
    isProcessingKVS = false;
    if (error_code !== 0 && log) {
        print("KVS.Set Fehler für Key '", nextItem.key, "': ", error_message, " (Code: ", error_code, ")");
    }
    if (nextItem.callback) nextItem.callback(result, error_code, error_message);
    processKVSQueue();
  });
}

function SafeKVS_Set(key, value, callback) {
  kvsQueue.push({key: key, value: value, callback: callback});
  processKVSQueue();
}

// ### Datumsformatierung (korrigiert) ###
function formatDate(dayOffset) {
  var d = new Date();
  if (dayOffset) {
    var currentTimestamp = d.getTime();
    var offsetMilliseconds = dayOffset * MS_PER_DAY;
    d = new Date(currentTimestamp + offsetMilliseconds);
  }
  var year = d.getFullYear();
  var month = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return year + "-" + month + "-" + day;
}

// ### Leistungsformatierung (Auto W/kW) ###
function formatPower(power) {
  if (power === null || typeof power === "undefined") return "N/A";
  return Math.abs(power) >= 1000 ? (power / 1000).toFixed(1) + "kW" : Math.round(power) + "W";
}

// ### Tageswechsel-Prüfung ###
function checkDayChange() {
  var now = new Date();
  var currentDay = now.getDate();
  
  if (currentDay !== lastDayChecked) {
    if (lastDayChecked !== -1) {
      if (log) print("Tageswechsel erkannt - Speichere Vortageswerte und resette Tageswerte.");
      var yesterdayStr = formatDate(-1);
      SafeKVS_Set("DailyEnergyConsumedKWh_" + yesterdayStr, dailyEnergyConsumedKWh.toFixed(3));
      SafeKVS_Set("DailyEnergyReturnedKWh_" + yesterdayStr, dailyEnergyReturnedKWh.toFixed(3));
      SafeKVS_Set("DailyEnergySelfConsumedKWh_" + yesterdayStr, dailyEnergySelfConsumedKWh.toFixed(3));
      SafeKVS_Set("DailyEnergyWastedKWh_" + yesterdayStr, dailyEnergyWastedKWh.toFixed(3));
    }
    
    dailyEnergyConsumedKWh = 0;
    dailyEnergyReturnedKWh = 0;
    dailyEnergySelfConsumedKWh = 0;
    dailyEnergyWastedKWh = 0;
    lastDayChecked = currentDay;

    if (log) print("Tageswerte zurückgesetzt. Neuer Tag:", formatDate(0));
  }
}

// ### KVS-Ladung ###
function loadKVS() {
  var keysToLoad = [
    "EnergyConsumedKWh", "EnergyReturnedKWh", "EnergySelfConsumedKWh", "EnergyWastedKWh",
    "DailyEnergyConsumedKWh", "DailyEnergyReturnedKWh", "DailyEnergySelfConsumedKWh", "DailyEnergyWastedKWh"
  ];
  var currentIndex = 0;

  function loadNextKey() {
    if (currentIndex >= keysToLoad.length) {
      if (lastDayChecked === -1) {
          lastDayChecked = new Date().getDate();
      }
      checkDayChange();

      // Timer starten, OpenDTU-Intervall wird hier verwendet
      Timer.set(OPENDTU_FETCH_INTERVAL_MS, true, fetchSolarPower); 
      Timer.set(60000, true, checkDayChange);
      Timer.set(3000, true, updatePowerDisplay);
      if (log) print("Initialisierung (KVS-Ladung und Timer-Setup) abgeschlossen. OpenDTU-Abfrage alle", OPENDTU_FETCH_INTERVAL_MS / 1000, "s.");
      return;
    }

    var key = keysToLoad[currentIndex];
    Shelly.call("KVS.Get", {key: key}, function(res) {
      if (res && typeof res.value !== "undefined" && res.value !== null) {
        var value = parseFloat(res.value);
        if (!isNaN(value)) {
          switch(key) {
            case "EnergyConsumedKWh": energyConsumedKWh = value; break;
            case "EnergyReturnedKWh": energyReturnedKWh = value; break;
            case "EnergySelfConsumedKWh": energySelfConsumedKWh = value; break;
            case "EnergyWastedKWh": energyWastedKWh = value; break;
            case "DailyEnergyConsumedKWh": dailyEnergyConsumedKWh = value; break;
            case "DailyEnergyReturnedKWh": dailyEnergyReturnedKWh = value; break;
            case "DailyEnergySelfConsumedKWh": dailyEnergySelfConsumedKWh = value; break;
            case "DailyEnergyWastedKWh": dailyEnergyWastedKWh = value; break;
          }
          if (log) print("Aus KVS geladen:", key + ":", value.toFixed(3));
        } else if (log) {
            print("KVS-Wert für '", key, "' ist keine gültige Zahl:", res.value);
        }
      }
      currentIndex++;
      loadNextKey();
    });
  }

  if (log) print("Starte KVS-Ladevorgang...");
  loadNextKey();
}

// ### OpenDTU-Abfrage ###
function fetchSolarPower() {
  if (!OPENDTU_API_URL) {
    if (log && solarPower !== 0) print("OpenDTU API URL nicht konfiguriert. Solarleistung wird auf 0 gesetzt.");
    solarPower = 0;
    return;
  }
  Shelly.call("HTTP.GET", {
    url: OPENDTU_API_URL,
    timeout: Math.max(5, Math.floor(OPENDTU_FETCH_INTERVAL_MS / 1000) -1) // Timeout etwas kürzer als das Intervall, aber mind. 5s
  }, function(response, error_code, error_message, userdata) {
    if (error_code !== 0 || !response || !response.body) {
      if (log) print("OpenDTU Fehler:", error_message || "Keine Antwort oder leerer Body. Code:", error_code);
      solarPower = 0;
      return;
    }

    try {
      var data = JSON.parse(response.body);
      if (data && data.total && data.total.Power && typeof data.total.Power.v !== "undefined") {
        solarPower = parseFloat(data.total.Power.v) || 0;
      } else {
        if (log) print("OpenDTU Parse-Warnung: Pfad 'total.Power.v' nicht in JSON-Antwort gefunden. Solarleistung auf 0 gesetzt.");
        solarPower = 0;
      }
      lastSolarUpdate = Date.now();
      if (showSolarInConsole && log) print("Solarleistung aktuell:", formatPower(solarPower));
    } catch(e) {
      if (log) print("OpenDTU Parse-Fehler:", e.toString());
      solarPower = 0;
    }
  });
}

// ### Funktion: Echtzeit-Anzeige-Update des Gerätenamens ###
function updatePowerDisplay() {
  if (!updateName) return;

  var emStatus = Shelly.getComponentStatus("em", 0);
  if (!emStatus) {
    if (log) print("Fehler beim Abrufen von emStatus für updatePowerDisplay.");
    return;
  }

  var phase1_W = emStatus.a_act_power || 0;
  var phase2_W = emStatus.b_act_power || 0;
  var phase3_W = emStatus.c_act_power || 0;
  var totalDisplayedPower_W = phase1_W + phase2_W + phase3_W;
  
  var dailySavingsKWh = dailyEnergySelfConsumedKWh + dailyEnergyReturnedKWh;
  
  var deviceName = "Aktuell: " + formatPower(totalDisplayedPower_W) + " | " +
                   "Solar: " + formatPower(solarPower) + " | " +
                   "Heute: " + dailyEnergyConsumedKWh.toFixed(2) + "kWh | " +
                   "Ersparnis: " + dailySavingsKWh.toFixed(2) + "kWh";

  Shelly.call("Sys.SetConfig", {
    config: {
      device: { name: deviceName }
    }
  }, function(result, error_code, error_message){
      if (error_code !== 0 && log) {
          print("Fehler beim Setzen des Gerätenamens:", error_message);
      }
  });
}

// ### Ws -> kWh Umrechnung mit Restwerterhaltung ###
function convertWsToKWhWithRemainder(currentWs, currentKWh) {
  var accumulatedWh = Math.floor(currentWs / WS_PER_WH);
  if (accumulatedWh !== 0) {
    currentKWh += accumulatedWh / WH_PER_KWH;
    currentWs -= accumulatedWh * WS_PER_WH;
  }
  return { ws: currentWs, kwh: currentKWh };
}

// ### Haupt-Timer (Energieberechnung) ###
var lastMQTTPublishTime = 0;
var lastKVSSaveTime = 0; // Zeitstempel der letzten KVS Speicherung

Timer.set(TIMER_INTERVAL_SECONDS * 1000, true, function() {
  var emStatus = Shelly.getComponentStatus("em", 0);
  if (!emStatus || typeof emStatus.total_act_power === "undefined") {
    if (log) print("Haupttimer: emStatus oder total_act_power nicht verfügbar.");
    return;
  }

  var gridPower_W = emStatus.total_act_power;
  var currentSolarPower_W = solarPower;

  var returnedEnergyInc_Ws = 0;
  var consumedEnergyInc_Ws = 0;
  var selfConsumedEnergyInc_Ws = 0;
  var wastedEnergyInc_Ws = 0;

  if (gridPower_W < 0) {
    returnedEnergyInc_Ws = -gridPower_W * TIMER_INTERVAL_SECONDS;
  } else {
    if (currentSolarPower_W > 0) {
      consumedEnergyInc_Ws = Math.max(0, gridPower_W - currentSolarPower_W) * TIMER_INTERVAL_SECONDS;
      selfConsumedEnergyInc_Ws = Math.min(currentSolarPower_W, gridPower_W) * TIMER_INTERVAL_SECONDS;
      wastedEnergyInc_Ws = Math.max(0, currentSolarPower_W - gridPower_W) * TIMER_INTERVAL_SECONDS;
    } else {
      consumedEnergyInc_Ws = gridPower_W * TIMER_INTERVAL_SECONDS;
    }
  }

  energyReturnedWs += returnedEnergyInc_Ws;
  energyConsumedWs += consumedEnergyInc_Ws;
  energySelfConsumedWs += selfConsumedEnergyInc_Ws;
  energyWastedWs += wastedEnergyInc_Ws;

  dailyEnergyReturnedKWh += returnedEnergyInc_Ws * WS_TO_KWH_FACTOR;
  dailyEnergyConsumedKWh += consumedEnergyInc_Ws * WS_TO_KWH_FACTOR;
  dailyEnergySelfConsumedKWh += selfConsumedEnergyInc_Ws * WS_TO_KWH_FACTOR;
  dailyEnergyWastedKWh += wastedEnergyInc_Ws * WS_TO_KWH_FACTOR;

  var converted = convertWsToKWhWithRemainder(energyConsumedWs, energyConsumedKWh);
  energyConsumedWs = converted.ws; energyConsumedKWh = converted.kwh;
  
  converted = convertWsToKWhWithRemainder(energyReturnedWs, energyReturnedKWh);
  energyReturnedWs = converted.ws; energyReturnedKWh = converted.kwh;
  
  converted = convertWsToKWhWithRemainder(energySelfConsumedWs, energySelfConsumedKWh);
  energySelfConsumedWs = converted.ws; energySelfConsumedKWh = converted.kwh;
  
  converted = convertWsToKWhWithRemainder(energyWastedWs, energyWastedKWh);
  energyWastedWs = converted.ws; energyWastedKWh = converted.kwh;

  var currentTime = Date.now();

  // MQTT-Publish alle MQTT_PUBLISH_INTERVAL_MS
  if (currentTime - lastMQTTPublishTime > MQTT_PUBLISH_INTERVAL_MS) {
    lastMQTTPublishTime = currentTime;
    
    if (MQTTpublish && typeof SHELLY_ID !== "undefined") {
      MQTT.publish(SHELLY_ID + "/energy/consumed_kwh", energyConsumedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/returned_kwh", energyReturnedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/self_consumed_kwh", energySelfConsumedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/wasted_kwh", energyWastedKWh.toFixed(3), 0, false);
      
      MQTT.publish(SHELLY_ID + "/energy/daily/consumed_kwh", dailyEnergyConsumedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/daily/returned_kwh", dailyEnergyReturnedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/daily/self_consumed_kwh", dailyEnergySelfConsumedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/daily/wasted_kwh", dailyEnergyWastedKWh.toFixed(3), 0, false);
      
      if (log) print("MQTT-Nachrichten publiziert (Intervall:", MQTT_PUBLISH_INTERVAL_MS / 1000, "s).");
    }
  }
  
  // KVS-Speicherung alle KVS_SAVE_INTERVAL_MS
  if (currentTime - lastKVSSaveTime > KVS_SAVE_INTERVAL_MS) {
    lastKVSSaveTime = currentTime;
    
    SafeKVS_Set("EnergyConsumedKWh", energyConsumedKWh.toFixed(3));
    SafeKVS_Set("EnergyReturnedKWh", energyReturnedKWh.toFixed(3));
    SafeKVS_Set("EnergySelfConsumedKWh", energySelfConsumedKWh.toFixed(3));
    SafeKVS_Set("EnergyWastedKWh", energyWastedKWh.toFixed(3));
    
    SafeKVS_Set("DailyEnergyConsumedKWh", dailyEnergyConsumedKWh.toFixed(3));
    SafeKVS_Set("DailyEnergyReturnedKWh", dailyEnergyReturnedKWh.toFixed(3));
    SafeKVS_Set("DailyEnergySelfConsumedKWh", dailyEnergySelfConsumedKWh.toFixed(3));
    SafeKVS_Set("DailyEnergyWastedKWh", dailyEnergyWastedKWh.toFixed(3));
    
    if (log) print("Energie-Gesamt- und Tageswerte im KVS gespeichert (Intervall:", KVS_SAVE_INTERVAL_MS / 1000, "s).");
  }
});

// Initialisierung des Skripts
if (log) print("Starte Energiezaehler-Skript");
loadKVS(); // Lade gespeicherte Werte und starte dann die Timer
