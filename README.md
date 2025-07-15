Shelly Pro 3EM Energy Counter & Solar Manager
Dieses Skript erweitert den Shelly Pro 3EM um eine detaillierte Energie- und Solar-Verbrauchsanalyse. Es wurde entwickelt, um nicht nur den Netzbezug und die Einspeisung zu erfassen, sondern auch den solaren Eigenverbrauch, den Autarkiegrad und den realen Brutto-Verbrauch auf der Phase zu berechnen, auf der die PV-Anlage einspeist.

Alle erfassten Daten werden persistent im KVS (Flash-Speicher) des Geräts gesichert und können via MQTT oder HTTP ausgelesen werden.

Kompatibilität: Getestet mit Firmware 1.7 Beta 3 (Juli 2025) und höher.

✨ Key Features
Präzise Energiezählung: Erfasst den gesamten Netzbezug und die Netzeinspeisung in kWh.

Solar-Analyse:

Berechnet den täglichen solaren Eigenverbrauch (gesparte Energie).

Berechnet die tägliche Netzeinspeisung (überschüssige Solarenergie).

Berechnet den Autarkiegrad in Prozent (Wie viel vom Verbrauch wird durch Solar gedeckt?).

Berechnet die Eigenverbrauchsquote in Prozent (Wie viel vom erzeugten Solarstrom wird selbst verbraucht?).

Brutto-Phasenverbrauch: Ermittelt den realen Gesamtverbrauch auf der Phase, an der die PV-Anlage angeschlossen ist (Netto-Messwert + Solarerzeugung).

Persistente Speicherung: Sichert alle Zählerstände alle 30 Minuten im KVS (Flash-Speicher) des Shelly, um Datenverlust bei einem Neustart zu verhindern.

Umfassendes MQTT-Publishing: Stellt alle relevanten Live- und Tageswerte über dedizierte MQTT-Topics bereit – ideal für die Integration in Smart-Home-Systeme wie ioBroker, Home Assistant etc.

Dynamischer Gerätename: Zeigt die wichtigsten Live-Werte direkt im Gerätenamen in der Shelly Web-UI an.

🚀 Setup & Konfiguration
1. Skript installieren
Öffne die Web-Oberfläche deines Shelly Pro 3EM.

Navigiere zu Scripts.

Klicke auf Add script und kopiere den gesamten Inhalt der energy_counter.js Datei in den Editor.

Speichere das Skript mit Save.

2. Einspeisephase konfigurieren
Öffne das Skript im Editor. Ganz oben findest du die folgende Zeile:

const SOLAR_FEED_IN_PHASE = 2; // 1=Phase A (L1), 2=Phase B (L2), 3=Phase C (L3)

Passe diesen Wert entsprechend der Phase an, auf der deine PV-Anlage einspeist. Dies ist entscheidend für die korrekte Berechnung des Phasen-Brutto-Verbrauchs.

3. Skript starten
Klicke auf den Play-Button (▶), um das Skript zu starten.

Aktiviere den Schalter Enable, damit das Skript nach einem Neustart des Shelly automatisch gestartet wird.

📊 Datenzugriff
Du kannst auf die vom Skript erfassten Daten auf drei Wegen zugreifen:

1. Gerätename (Web-UI)
Die wichtigsten Live-Werte werden direkt im Gerätenamen angezeigt, z.B.:
Akt:-1.2kW Sol:2.1kW Tag:3.4kWh Spar:5.6kWh

2. MQTT-Topics
Wenn MQTT im Skript aktiviert ist (MQTTpublish = true), werden die folgenden Werte unter dem Topic <deine-shelly-id>/... veröffentlicht:

Topic

Beschreibung

Einheit

Live-Werte





/power/grid_total_watts

Aktuelle Gesamtleistung am Netzpunkt (positiv=Bezug)

W

/power/phaseX_gross_consumption_watts

Realer Brutto-Verbrauch auf der Einspeisephase

W

Tageswerte (kWh)





/energy_daily/grid_consumed_kwh

Heutiger Gesamt-Netzbezug

kWh

/energy_daily/solar_self_consumption_kwh

Heutiger solarer Eigenverbrauch

kWh

/energy_daily/solar_to_grid_kwh

Heutige Netzeinspeisung

kWh

Tageswerte (%)





/energy_daily/autarky_rate_percent

Aktueller Autarkiegrad des Tages

%

/energy_daily/self_consumption_rate_percent

Aktuelle Eigenverbrauchsquote des Tages

%

Gesamtzähler





/energy_counter/consumed_total_kwh

Gesamter Netzbezug seit Start

kWh

/energy_counter/returned_total_kwh

Gesamte Netzeinspeisung seit Start

kWh

Hinweis: phaseX im Topic wird dynamisch zu phase1, phase2 oder phase3, basierend auf deiner Konfiguration.

3. HTTP-Endpunkt
Du kannst die Werte, die im Gerätenamen angezeigt werden, auch über einen HTTP-Aufruf abfragen:

http://<SHELLY_IP>/script/<script_id>/energy_counter

Ersetze <SHELLY_IP> und <script_id> mit den Daten deines Geräts.

🛠️ Manuelle Anpassung der Zählerstände
Falls du die Zählerstände an deinen offiziellen Stromzähler anpassen möchtest, kannst du dies über die Konsole des Skript-Editors tun:

Starte das Skript mindestens einmal, damit die KVS-Schlüssel initialisiert werden.

Öffne die Konsole unterhalb des Skript-Editors.

Gib die folgenden Befehle ein, um die Werte zu setzen (Beispielwerte):

// Netzbezug auf 1234.5 kWh setzen
SetKVS("EnergyConsumedKWh", 1234.5);

// Netzeinspeisung auf 678.9 kWh setzen
SetKVS("EnergyReturnedKWh", 678.9);

Wichtig: Stoppe und starte das Skript danach sofort neu, damit die neuen Werte geladen und verwendet werden.

📜 Changelog
v1.7 (Juli 2025)
Feature: Berechnung von Autarkiegrad und Eigenverbrauchsquote direkt im Skript.

Feature: Neue MQTT-Topics /energy_daily/autarky_rate_percent und /energy_daily/self_consumption_rate_percent.

Verbesserung: Code-Struktur optimiert und für bessere Lesbarkeit gekürzt.

v1.6
Feature: Die solare Einspeisephase kann nun einfach über die Konstante SOLAR_FEED_IN_PHASE am Anfang des Skripts konfiguriert werden.

Verbesserung: MQTT-Topic und interne Berechnungen für den Phasen-Brutto-Verbrauch passen sich dynamisch an die Konfiguration an.

v1.5
Feature: Berechnung des realen Brutto-Verbrauchs für die Einspeisephase (Netto-Messwert + Solarleistung).

Feature: Neuer MQTT-Topic /power/phaseX_gross_consumption_watts.

v1.4
Feature: Erfassung von solarem Eigenverbrauch und Netzeinspeisung.

Feature: Einführung von täglichen Zählern, die um Mitternacht automatisch zurückgesetzt werden.

Verbesserung: Robustere Speicher- und Lade-Routinen für KVS.

v1.0
Initiales Release.

Grundlegende Zählung von Netzbezug (consumed) und Einspeisung (returned).

Persistente Speicherung im KVS.

MQTT-Publishing der Basiszähler.
