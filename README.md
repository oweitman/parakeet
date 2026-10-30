# Parakeet Client/Server-Demo

Live-Transkription eines Browser-Mikrofons mit einem JavaScript-Backend auf der CPU. Das Frontend ist eine einfache HTML-Seite mit Mikrofon an/aus, Transkript und Laufzeitmessungen. Die Erkennung erfolgt im Backend mit **Parakeet TDT 0.6B v3 ONNX (INT8)** über `parakeet.js` und `onnxruntime-node`. Deutsch und Englisch sowie weitere vom Modell unterstützte Sprachen werden automatisch erkannt; es findet keine Übersetzung statt.

Audio wird nur in begrenzten RAM-Puffern verarbeitet und nicht gespeichert. Das Transkript bleibt im Browser und wird beim Neuladen oder Start einer neuen Aufnahme geleert. Ein abschaltbares Korrekturwörterbuch vereinheitlicht bekannte Erkennungsvarianten; die unveränderte Modellausgabe wird zusätzlich angezeigt.

## Voraussetzungen

- Linux x64 und Node.js 22 oder neuer mit npm. Auch unter Windows getestet.
- CPU; keine GPU, CUDA-Installation, Python-Umgebung oder Frontend-Build erforderlich.
- Mehrere GB verfügbarer RAM und etwa 700 MB für die Modelle zusätzlich zu den npm-Abhängigkeiten. Modell und Runtime benötigen im Leerlauf größenordnungsmäßig 0,8 GiB RAM; Last und Plattform beeinflussen den Verbrauch.
- Netzwerkzugriff für `npm ci` und den ersten Modelldownload. Anschließend läuft die Erkennung lokal im Backend.
- Aktueller Browser mit Mikrofonzugriff und AudioWorklet. Beim Zugriff von anderen Rechnern HTTPS mit einem im Browser vertrauenswürdigen Zertifikat verwenden.

## Installation und Start

`<REPOSITORY_URL>` durch die URL dieses GitHub-Repositories ersetzen. Befehle für Linux:

```sh
git clone <REPOSITORY_URL> parakeet-demo
cd parakeet-demo
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev
npm run download-model
npm run smoke
npm start
```

`ONNXRUNTIME_NODE_INSTALL=skip` überspringt zusätzliche CUDA-Downloads. Die native CPU-Runtime ist im npm-Paket enthalten. Modelle werden nach `models/` geladen; npm-Abhängigkeiten und Modelle sind nicht Bestandteil des Git-Repositories. Den Modelldownload vor dem ersten Start vollständig abschließen. Alle Befehle im Projektverzeichnis ausführen.

Das Backend lauscht standardmäßig auf **127.0.0.1:9999**. Sobald `CPU model ready` erscheint, ist es bereit. Auf demselben Rechner ist die Seite unter **http://localhost:9999** erreichbar. `Strg+C` beendet den Prozess. Unter Windows die Installation in PowerShell mit `$env:ONNXRUNTIME_NODE_INSTALL='skip'; npm ci --omit=dev` ausführen; die übrigen npm-Befehle bleiben gleich.

Für andere Rechner direktes HTTPS über einen Reverse Proxy verwenden:

```text
Browser → HTTPS/WSS → Reverse Proxy → HTTP/WS → Node.js auf 127.0.0.1:9999
```

[SERVER.md](SERVER.md) enthält eine Nginx-Konfiguration, Prüfkommandos und Hinweise für eigene Prozessverwaltung. Im Frontend müssen keine Serveradressen eingetragen werden: Es verwendet automatisch Host, Port und Protokoll der geöffneten Seite.

Als Alternative für einen Test ohne HTTPS-Einrichtung ist dort auch ein [SSH-Tunnel](SERVER.md#alternative-ssh-tunnel-ohne-https-einrichtung) beschrieben. Dabei öffnet der Browser `http://localhost:9999`, während das Backend auf dem entfernten Server läuft.

## Konfiguration

Umgebungsvariablen vor dem Start setzen; eine `.env`-Datei wird nicht automatisch geladen.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind-Adresse des Node-Backends |
| `PORT` | `9999` | HTTP-/WebSocket-Port des Node-Backends |
| `CPU_THREADS` | `4` | ONNX-CPU-Threads; `1` für einen Thread |
| `MAX_CLIENTS` | `8` | Maximale Browserverbindungen; keine Leistungszusage |
| `VAD_THRESHOLD` | `0.008` | RMS-Energieschwelle; kleiner für leise Stimmen, größer gegen Grundrauschen |
| `MODEL_DIR` | `models` | Absoluter Modellpfad oder Pfad relativ zum Arbeitsverzeichnis |
| `CORRECTIONS_FILE` | `config/corrections.json` | JSON-Korrekturwörterbuch, absolut oder relativ zum Arbeitsverzeichnis |
| `CORRECTIONS_ENABLED` | `1` | Mit `0` die Korrektur auf dem Backend vollständig deaktivieren |

Beispiel: `HOST=127.0.0.1 PORT=9999 CPU_THREADS=4 npm start`.

## Korrekturwörterbuch

In [config/corrections.json](config/corrections.json) stehen Zielschreibweisen und tatsächlich beobachtete Erkennungsvarianten:

```json
{
  "enabled": true,
  "rules": [
    {
      "replacement": "ioBroker",
      "variants": ["io broker", "eio broker", "iobokrer"]
    }
  ]
}
```

Die Korrektur verarbeitet Zwischenstände und finale Abschnitte nach der Erkennung auf dem Backend. Sie gleicht Groß-/Kleinschreibung und variable Leerzeichen ab, ersetzt nur vollständige Wörter bzw. Wortgruppen und lässt Satzzeichen bestehen. Längere Varianten werden bevorzugt; Ersetzungen lösen keine weiteren Ersetzungen aus. Varianten sind wörtliche Texte, keine regulären Ausdrücke. Weitere Regeln nach demselben Schema ergänzen und das Backend danach neu starten. Fehlerhaftes JSON oder widersprüchliche Varianten verhindern den Start mit einer Fehlermeldung.

Im Browser schaltet **Korrekturwörterbuch anwenden** die angezeigte Fassung um, auch während oder nach einer Aufnahme. Das zweite Textfeld zeigt immer die unveränderte **Originalerkennung**. Dieser Vergleich verändert weder die Modellerkennung noch die Aufnahme. Zum vollständigen Deaktivieren `"enabled": false` setzen oder mit `CORRECTIONS_ENABLED=0 npm start` starten; die Browseroption ist dann deaktiviert.

Die Regeln korrigieren ausschließlich den ausgegebenen Text. Sie trainieren das Modell nicht und bevorzugen keine Aussprache beim Decodieren. Neue Varianten zuerst anhand der Originalerkennung sammeln. Allgemeine Regeln wie `broker` → `ioBroker` vermeiden, da sie auch korrekte Texte ändern würden.

## Prüfen

```sh
npm test
npm run smoke
npm run smoke:stream
curl --fail http://127.0.0.1:9999/health
```

- `npm test`: Tests für Segmentierung, Resampling, AudioWorklet-Abschluss, Warteschlange und Korrekturwörterbuch; benötigt keine Modelle.
- `npm run smoke`: Echte CPU-Inferenz mit einer Sekunde Stille. Optional `npm run smoke -- /path/to/audio.f32` für rohe Mono-Float32-PCM-Daten mit 16 kHz, Little Endian, ohne WAV-Container.
- `npm run smoke:stream`: Temporärer Server auf einem freien lokalen Port, zwei gleichzeitige synthetische WebSocket-Streams, Zwischenstände, Stop-Abschluss, Stille und ungültiges PCM. Beendet seinen Testserver selbst.
- `/health`: HTTP 200 mit `"ready":true`, sobald das Modell geladen ist; vorher HTTP 503. Enthält Modellstatus, Verbindungszahl und Warteschlange, keine Audio- oder Transkriptinhalte.

CPU-Inferenz und synthetische Streamingtests wurden unter Linux x64 mit Node.js 24 und Windows mit Node.js 22 geprüft. Diese Tests bewerten keine Erkennungsqualität mit echter Sprache. Mikrofonzugriff, Deutsch-/Englisch-Erkennung, Latenz und gewünschte Nutzerzahl in der Zielumgebung separat testen.

## Verarbeitung und Grenzen

Browser-Mikrofon → AudioWorklet → Mono-PCM mit 16 kHz → WebSocket in 100-ms-Paketen → Sitzungspuffer → Scheduler → Inferenz-Worker → Transkript per WebSocket.

- `parakeet.js` ist primär ein Browserpaket. Diese Demo verbindet seinen `ParakeetModel`-Konstruktor, JS-Mel-Preprocessor und Tokenizer mit nativen `onnxruntime-node`-CPU-Sitzungen. Der interne Tokenizer-Import ist an die festgelegte Paketversion gebunden. Paket-Upgrades erneut mit den Modellen testen.
- Ein wachsender Sprachabschnitt wird ungefähr alle 1,5 Sekunden neu erkannt. Nach etwa 800 ms Stille oder spätestens 12 Sekunden wird er abgeschlossen. Zwischenstände werden ersetzt. An erzwungenen Abschnittsgrenzen können Wörter geteilt werden; die einfache Energieschwelle ersetzt keinen neuronalen VAD.
- Ziel sind 1–3 Sekunden Verzögerung, abhängig von Hardware und Last. Ein Worker teilt ein geladenes Modell zwischen Nutzern und verarbeitet die Inferenz seriell. Wiederholte Erkennung wachsender Fenster erhöht den Rechenaufwand; mehrere Nutzer erhöhen die Wartezeiten.
- Angezeigt werden Inferenzdauer, Wartezeit, Audiofensterlänge und RTF (Inferenzdauer/Audiofensterdauer). Das ist keine Ende-zu-Ende-Latenzmessung und kein Lastbenchmark.
- Überholte wartende Zwischenstände werden ersetzt, finale Abschnitte bleiben erhalten. Mehr als 45 Sekunden wartendes Audio pro Nutzer, zu schnelle Uploads oder langsame Clientverbindungen führen zu einem sichtbaren Fehler. Sitzungen enden spätestens nach 30 Minuten. Bei Verbindungsabbruch wird ausstehendes Audio verworfen; es gibt keine automatische Wiederaufnahme.

## Weitergabe und Modellherkunft

Für GitHub den Quellcode einschließlich `package-lock.json` bereitstellen. `.gitignore` schließt Modelle, `node_modules`, npm-Cache, Archive, lokale Umgebungsdateien und Laufzeitdateien aus. Die Zielinstallation lädt ihre Modelle selbst herunter und installiert die passenden nativen Abhängigkeiten.

Optional erzeugt `npm run pack:server` mit `tar` ein Archiv unter `dist/parakeet-demo.tar.gz`, das Quellcode und bereits vorhandene Modelle enthält. Damit entfällt der erneute Modelldownload bei einer manuellen Übertragung. Auf dem Zielsystem weiterhin `ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev` ausführen.

Das Archiv enthält auch `config/corrections.json`. Vor einer Weitergabe eigene Wörterbucheinträge auf vertrauliche Namen oder Begriffe prüfen.

Paket: [parakeet.js](https://github.com/ysdede/parakeet.js), MIT. Modell: [Parakeet TDT 0.6B v3 ONNX](https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx), dort CC-BY-4.0 ausgewiesen; Model Card und ATTRIBUTION.md beachten. INT8 kann gegenüber FP32 andere Ergebnisse liefern. Der Downloader hält die verwendete Hugging-Face-Revision und Dateigrößen in `models/model.json` fest.

Bei der geprüften Runtime-Version meldete npm Audit Funde in `onnxruntime-node` → `adm-zip` (Installationshelfer). Vor einem Runtime-Upgrade die Kompatibilität erneut prüfen; diese Demo führt keine automatischen Versionswechsel aus.
