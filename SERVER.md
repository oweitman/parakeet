# Installation in eigener Server-Infrastruktur

Die Installation aus dem GitHub-Checkout ist in [README.md](README.md#installation-und-start) beschrieben. Dieses Dokument ergänzt den direkten Browserzugriff über HTTPS. Alle Domainnamen und Zertifikatspfade unten sind Beispiele und müssen an die eigene Infrastruktur angepasst werden.

Für einen Test ohne Reverse Proxy und Zertifikat gibt es alternativ den [SSH-Tunnel](#alternative-ssh-tunnel-ohne-https-einrichtung).

## Backend

Node.js 22 oder neuer, Linux x64 und mehrere GB verfügbarer RAM. Im Projektverzeichnis installieren, Modelle herunterladen und testen:

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev
npm run download-model
npm test
npm run smoke
HOST=127.0.0.1 PORT=9999 CPU_THREADS=4 npm start
```

Nach `CPU model ready` muss `curl --fail http://127.0.0.1:9999/health` HTTP 200 und `"ready":true` liefern. Das Backend liefert HTML, JavaScript und WebSocket-Endpunkt gemeinsam aus. Es benötigt keinen separaten Frontend-Server oder Build.

Für den dauerhaften Betrieb den Prozess mit der eigenen Dienstverwaltung starten, z. B. systemd. Arbeitsverzeichnis auf das Projektverzeichnis setzen oder `MODEL_DIR` absolut angeben. Der Dienstbenutzer benötigt Lesezugriff auf Anwendung und Modelle. Bei Node-Version-Managern den tatsächlichen Node-Pfad verwenden; Dienste laden üblicherweise keine interaktive Shell-Konfiguration. Keine Root-Ausführung für das Backend erforderlich.

## HTTPS und Reverse Proxy

Empfohlene Zuordnung:

| Zugriff | Adresse |
| --- | --- |
| Browser | `https://transcribe.example.org` |
| Reverse Proxy → Backend | `http://127.0.0.1:9999` |
| WebSocket im Browser | `wss://transcribe.example.org/audio` |

DNS und TLS-Zertifikat über die vorhandene Infrastruktur bereitstellen. Bei einer internen CA muss deren Stammzertifikat auf den Browser-Rechnern vertrauenswürdig installiert sein. Ein gewöhnlicher HTTP-Aufruf über eine Server-IP reicht für den Mikrofonzugriff nicht aus. Das Frontend nutzt automatisch dieselbe Origin für HTTP und WebSocket.

Eine vollständige Nginx-Beispielkonfiguration steht in [deploy/nginx.conf](deploy/nginx.conf). Sie wird im `http`-Kontext eingebunden, z. B. über `conf.d` oder `sites-enabled`. Domain und Zertifikatspfade anpassen, dann mit `nginx -t` prüfen und Nginx über die eigene Dienstverwaltung neu laden. Bereits vorhandene TLS-/Authentifizierungseinstellungen entsprechend integrieren.

Die Konfiguration leitet alle Pfade an das Backend weiter, einschließlich `/audio` und `/health`. Für andere Reverse Proxies gelten dieselben Anforderungen:

- WebSocket-Upgrade zulassen und bei Bedarf HTTP/1.1 zum Backend verwenden.
- Den ursprünglichen `Host`-Header einschließlich eines eventuell abweichenden externen Ports erhalten. Das Backend vergleicht ihn mit der Browser-Origin; eine Ersetzung durch `127.0.0.1:9999` verhindert die Verbindung.
- WebSocket-Timeout ausreichend lang setzen; das Beispiel verwendet 1900 Sekunden bei maximal 30 Minuten Sitzungsdauer.
- Unter einer eigenen Domain am URL-Stamm `/` veröffentlichen. Das Frontend verwendet absolute Pfade; ein Unterpfad wie `/parakeet/` wird nicht unterstützt.

Port **9999** ist standardmäßig der interne Backend-Port, der Browser verwendet HTTPS-Port **443**. Falls auch der öffentliche HTTPS-Zugriff auf Port 9999 erfolgen soll, Nginx auf `9999 ssl` lauschen lassen, das Backend z. B. mit `PORT=9998` starten und `proxy_pass` auf `http://127.0.0.1:9998` ändern. Browseradresse dann `https://transcribe.example.org:9999`. Beide Prozesse können nicht dieselbe Adresse und denselben Port belegen.

Stehen Proxy und Backend auf unterschiedlichen Rechnern oder in Containern, Bind-Adresse, Upstream und internes Netz entsprechend anpassen. Nur der Proxy muss für die Browser erreichbar sein. Die Demo enthält keinen Login; einen benötigten Zugriffsschutz am Proxy oder in der vorhandenen Infrastruktur einrichten.

## Alternative: SSH-Tunnel ohne HTTPS-Einrichtung

Das Backend wie oben auf dem entfernten Server an `127.0.0.1:9999` starten. Auf dem Rechner mit dem Browser folgenden Befehl ausführen und `<SSH_USER>` sowie `<SERVER_HOST>` durch den eigenen SSH-Zugang ersetzen:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:9999:127.0.0.1:9999 <SSH_USER>@<SERVER_HOST>
```

Der Befehl funktioniert auch in Windows PowerShell mit installiertem OpenSSH-Client. Das Terminal geöffnet lassen und im Browser **http://localhost:9999** aufrufen. Der Browser erlaubt Mikrofonzugriff auf localhost; die Verbindung zum entfernten Backend läuft verschlüsselt über SSH. Ein HTTPS-Zertifikat oder Reverse Proxy wird für diese Variante nicht benötigt.

Der SSH-Server muss TCP-Weiterleitungen erlauben, und der lokale Port 9999 muss frei sein. `Strg+C` im Tunnel-Terminal beendet die Weiterleitung; das Backend wird separat beendet. Jeder weitere Browser-Rechner benötigt einen eigenen Tunnel und SSH-Zugang. Falls lokal bereits Port 9999 belegt ist, z. B. `-L 127.0.0.1:10000:127.0.0.1:9999` verwenden und `http://localhost:10000` öffnen. Der entfernte Backend-Port bleibt 9999.

Prüfen: `curl --fail http://localhost:9999/health` auf dem Browser-Rechner muss bei geladenem Modell `"ready":true` melden. Anschließend Aufnahme, Textaktualisierungen und Stop-Abschluss im Browser testen.

## Funktionstest über HTTPS

1. Backendstatus intern mit `curl --fail http://127.0.0.1:9999/health` prüfen.
2. Öffentliche Route mit `curl --fail https://transcribe.example.org/health` prüfen.
3. `https://transcribe.example.org` im Browser öffnen, Mikrofon freigeben und Deutsch/Englisch sprechen.
4. In den Browser-Entwicklerwerkzeugen prüfen, dass `/audio` per WSS mit Status 101 verbunden ist und Textaktualisierungen eintreffen.
5. Mikrofon deaktivieren; der letzte Abschnitt muss fertig verarbeitet werden und der Mikrofonzugriff enden.
6. Gewünschte Parallelität mit mehreren Browsern testen und Inferenz-/Wartezeiten sowie Prozess-RAM messen.

`npm run smoke:stream` prüft zusätzlich mit dem echten Modell zwei synthetische Clients gegen einen temporären lokalen Testserver. Das prüft den Backend-Datenweg, nicht den HTTPS-Proxy, das Mikrofon oder Sprachqualität.

Bei HTTP 503: Modellbereitschaft, Startprotokoll und maximale Clientzahl prüfen. Bei einem fehlgeschlagenen WebSocket-Handshake zusätzlich Origin/Host und Upgrade-Header prüfen. Bei nicht verfügbarem Mikrofon HTTPS, Zertifikatsvertrauen und Browserberechtigung prüfen.

Referenzen: [Nginx WebSocket-Proxy](https://nginx.org/en/docs/http/websocket.html), [Proxy-Header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header), [Browser-Mikrofon und sichere Kontexte](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#privacy_and_security).
