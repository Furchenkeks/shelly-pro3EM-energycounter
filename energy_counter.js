// Energiezähler-Daten
var energyReturnedWs = 0.0;
var energyConsumedWs = 0.0;
var energySelfConsumedWs = 0.0;
var energyWastedWs = 0.0;

var energyReturnedKWh = 0.0;
var energyConsumedKWh = 0.0;
var energySelfConsumedKWh = 0.0;
var energyWastedKWh = 0.0;

// OpenDTU-Konfiguration
var OPENDTU_API_URL = "http://192.168.1.100/api/livedata/status"; // IP ADRESSE anpassen
var solarPower = 0.0;
var lastSolarUpdate = 0;

// Einstellungen
var log = 1;
var MQTTpublish = true;
var updateName = true;

// MQTT-Konfiguration
var SHELLY_ID = undefined;
Shelly.call("Mqtt.GetConfig", "", function(res) {
  if (res && res.topic_prefix) SHELLY_ID = res.topic_prefix;
});

// ### Kompatible KVS-Warteschlange ###
var kvsQueue = [];
var isProcessingKVS = false;

function processKVSQueue() {
  if (isProcessingKVS || kvsQueue.length === 0) return;
  
  isProcessingKVS = true;
  var nextItem = kvsQueue[0]; // Manuelles "shift" ersetzen
  kvsQueue = kvsQueue.slice(1); // Entfernt erstes Element
  
  Shelly.call("KVS.Set", {key: nextItem.key, value: nextItem.value}, function() {
    isProcessingKVS = false;
    if (nextItem.callback) nextItem.callback();
    processKVSQueue();
  });
}

function SafeKVS_Set(key, value, callback) {
  kvsQueue[kvsQueue.length] = {key: key, value: value, callback: callback}; // push() Ersatz
  processKVSQueue();
}

// ### Initiale Ladung der KVS-Werte ###
function loadKVS() {
  var keys = ["EnergyConsumedKWh", "EnergyReturnedKWh", "EnergySelfConsumedKWh", "EnergyWastedKWh"];
  var loadedCount = 0;
  
  for (var i = 0; i < keys.length; i++) {
    Shelly.call("KVS.Get", {key: keys[i]}, (function(key) {
      return function(res) {
        if (res && res.value !== undefined && res.value !== null) {
          var value = parseFloat(res.value);
          if (!isNaN(value)) {
            switch(key) {
              case "EnergyConsumedKWh": energyConsumedKWh = value; break;
              case "EnergyReturnedKWh": energyReturnedKWh = value; break;
              case "EnergySelfConsumedKWh": energySelfConsumedKWh = value; break;
              case "EnergyWastedKWh": energyWastedKWh = value; break;
            }
            if (log) print("Geladen", key + ":", value);
          }
        }
        loadedCount++;
        if (loadedCount === keys.length) initComplete();
      };
    })(keys[i]));
  }
}

function initComplete() {
  Timer.set(10000, true, fetchSolarPower, null);  // Aktuallisierung der Daten von OPENDTU
  if (log) print("Initialisierung abgeschlossen");
}

// ### OpenDTU-Abfrage ###
function fetchSolarPower() {
  Shelly.call("HTTP.GET", {
    url: OPENDTU_API_URL,
    timeout: 10
  }, function(response, error_code, error_message) {
    if (error_code !== 0 || !response || !response.body) {
      if (log) print("OpenDTU Fehler:", error_message || "Keine Antwort");
      solarPower = 0;
      return;
    }

    try {
      var data = JSON.parse(response.body);
      solarPower = (data.total && data.total.Power && data.total.Power.v) || 0;
      lastSolarUpdate = Date.now();
      if (log) print("SolarPower:", solarPower + "W");
    } catch(e) {
      if (log) print("OpenDTU Parse-Fehler:", e);
      solarPower = 0;
    }
  });
}

// ### Haupt-Timer ###
var lastMQTTPublish = 0;
Timer.set(500, true, function() {
  var em = Shelly.getComponentStatus("em", 0);
  if (!em || typeof em.total_act_power === "undefined") return;

  var gridPower = em.total_act_power;
  
  // Energiefluss-Berechnung
  if (gridPower < 0) {
    energyReturnedWs += -gridPower * 0.5;
  } else {
    if (solarPower > 0) {
      var selfConsumed = Math.min(solarPower, gridPower);
      var wasted = Math.max(0, solarPower - gridPower);
      
      energySelfConsumedWs += selfConsumed * 0.5;
      energyWastedWs += wasted * 0.5;
      energyConsumedWs += Math.max(0, gridPower - selfConsumed) * 0.5;
    } else {
      energyConsumedWs += gridPower * 0.5;
    }
  }

  // Ws → kWh Umrechnung
  function convert(ws, kwh) {
    var wh = Math.floor(ws / 3600);
    if (wh > 0) {
      kwh += wh / 1000;
      ws -= wh * 3600;
    }
    return {ws: ws, kwh: kwh};
  }
  
  var consumed = convert(energyConsumedWs, energyConsumedKWh);
  energyConsumedWs = consumed.ws;
  energyConsumedKWh = consumed.kwh;
  
  var returned = convert(energyReturnedWs, energyReturnedKWh);
  energyReturnedWs = returned.ws;
  energyReturnedKWh = returned.kwh;
  
  var selfConsumed = convert(energySelfConsumedWs, energySelfConsumedKWh);
  energySelfConsumedWs = selfConsumed.ws;
  energySelfConsumedKWh = selfConsumed.kwh;
  
  var wasted = convert(energyWastedWs, energyWastedKWh);
  energyWastedWs = wasted.ws;
  energyWastedKWh = wasted.kwh;

  // Alle 20s aktualisieren
  if (Date.now() - lastMQTTPublish > 20000) {
    lastMQTTPublish = Date.now();
    
    if (updateName) {
      Shelly.call("Sys.SetConfig", {
        config: {
          device: {
            name: "Ver: " + energyConsumedKWh.toFixed(3) + "kWh | " +
                  "Eig: " + energySelfConsumedKWh.toFixed(3) + "kWh | " +
                  "Rück: " + energyReturnedKWh.toFixed(3) + "kWh | " +
                  "Verl: " + energyWastedKWh.toFixed(3) + "kWh"
          }
        }
      }, null);
    }
    
    if (MQTTpublish && SHELLY_ID) {
      MQTT.publish(SHELLY_ID + "/energy/consumed", energyConsumedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/returned", energyReturnedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/self_consumed", energySelfConsumedKWh.toFixed(3), 0, false);
      MQTT.publish(SHELLY_ID + "/energy/wasted", energyWastedKWh.toFixed(3), 0, false);
    }
    
    // Serialisierte KVS-Speicherung
    SafeKVS_Set("EnergyConsumedKWh", energyConsumedKWh);
    SafeKVS_Set("EnergyReturnedKWh", energyReturnedKWh);
    SafeKVS_Set("EnergySelfConsumedKWh", energySelfConsumedKWh);
    SafeKVS_Set("EnergyWastedKWh", energyWastedKWh);
  }
});

// Initialisierung
loadKVS();

// HTTP-API
HTTPServer.registerEndpoint("energy", function(request, response) {
  response.code = 200;
  response.body = JSON.stringify({
    consumed_kWh: energyConsumedKWh.toFixed(3),
    returned_kWh: energyReturnedKWh.toFixed(3),
    self_consumed_kWh: energySelfConsumedKWh.toFixed(3),
    wasted_kWh: energyWastedKWh.toFixed(3),
    solar_power: solarPower.toFixed(1),
    last_update: new Date().toISOString(),
    kvs_queue: kvsQueue.length
  });
  response.send();
});
