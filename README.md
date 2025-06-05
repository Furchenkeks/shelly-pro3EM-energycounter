Dieses Script läuft mit der aktuellen Version 1.6.1 (Juni 2025)


# shelly-pro3EM-energycounter

This is a shelly script that runs on the Shelly Pro 3EM with firmware >= 1.0.0.

It samples the total_instant_power every 500ms and integrates it into two variables: consumed and returned energy.
The results is written into the "name" field of the device. Therefore its visible in the headline of the web-interface and can also be queried by the iobroker.shelly plugin.
KVS flash storage is used add persistance to the measured energy values; they are saved every half hour.

Additionally, the values are published on MQTT under <device name>/energy_counter
This can be disabled by setting "MQTTpublish" to false in the header of the script.

There is one more way to read the counters:
http://<SHELLY_IP>/script/<script_id>/energy_counter
returns the same string as in "name".

# Setup

Simply add a new script in the Pro3EM and copy the contents of the energy_counter.js file into it. Then press "Save" and "Start".

You can write initial values for the energy counters like this: (for example to make it match your grid energy meter)
- start the script
- type into the debug console below the script: "SetKVS("EnergyConsumedKWh", 100.1 );" to set the consumed energy to 100.1 KWh.
- immediately after changing, stop and start the script again. Confirm that the values have been accepted.

