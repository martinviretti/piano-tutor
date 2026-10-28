# Piano Tutor

Aprendé a tocar una canción en el piano **nota a nota**: le pasás un video de YouTube (o un archivo de audio), una IA saca las notas y la app te las muestra en un teclado de a 1, de a 3 o de a las que quieras. Avanzás con la barra espaciadora a tu ritmo.

- La IA es [basic-pitch](https://github.com/spotify/basic-pitch-ts) de Spotify y corre **en tu navegador** (no se manda audio a ningún servidor externo).
- Todo ocupa unos **25 MB**. No hace falta Python ni ffmpeg.

## Requisitos

- **Node.js 18 o superior** — [nodejs.org](https://nodejs.org) (versión LTS).
- **Chrome o Edge** (para la opción "Escuchar el video").
- Internet: para YouTube y para cargar la IA la primera vez.

## Cómo usarla

1. Bajá el repo (botón **Code → Download ZIP** o `git clone`).
2. **Windows:** doble clic en `iniciar.bat`.
   **Mac/Linux:** en una terminal dentro de la carpeta, `npm start` y abrí http://localhost:3737
3. Pegá el link de YouTube y tocá **Cargar**.
4. Elegí cómo sacar las notas:
   - **Descargar audio y transcribir** — baja solo el audio del video con [yt-dlp](https://github.com/yt-dlp/yt-dlp) (se descarga solo la primera vez que arrancás la app). Es lo más rápido.
   - **Escuchar el video y transcribir** — si YouTube bloquea la descarga. El navegador te pide compartir una pestaña: elegí **esta pestaña** y dejá marcado **"Compartir audio"**. El video se reproduce entero mientras la app lo escucha (no lo pauses ni lo mutees). Podés cortar antes con **Terminar acá**.
   - **Subir archivo** — cualquier audio o video que tengas en la PC.
5. Practicá.

La canción queda guardada en el navegador: la próxima vez aparece en **Canciones guardadas** y abre al instante, en el paso donde la dejaste.

## Controles

| Tecla | Acción |
|---|---|
| `Espacio` / `→` | Siguiente grupo de notas |
| `←` | Anterior |
| `R` / `Enter` | Escuchar las notas del grupo (sintetizador) |
| `O` | Escuchar ese pedacito del video original |
| `1`–`6`, `8` | Cuántas notas por paso |
| `Inicio` | Volver al principio |

En el teclado, las teclas naranjas son las que tenés que tocar, con un número que indica el orden (`2·3` = esa tecla va segunda y tercera). La marca verde agua abajo de una tecla es lo que viene después. También podés hacer clic en las teclas para escucharlas.

### Ajustes

- **Qué tocar:** *Solo melodía* (la nota más aguda de cada momento, ideal para empezar), *Melodía + acordes* (mano derecha) o *Todas las notas* (las dos manos).
- **Sensibilidad:** si faltan notas, subila; si aparecen notas de más, bajala. Recalcula al instante, sin volver a correr la IA.
- **Velocidad:** afecta a *Escuchar* y *Original*.
- **Nombres:** Do Re Mi o C D E. `Do4` es el Do central.

## Limitaciones (para que no te sorprendan)

- Funciona mucho mejor con **piano solo** (tutoriales, covers de piano). Con banda completa la IA mezcla voz, guitarra y batería, y la melodía sale sucia.
- Es una transcripción automática: puede errar alguna nota u octava. Usá *Original* para comparar con el oído.
- **YouTube a veces bloquea la descarga** ("confirmá que no sos un bot"), sobre todo desde redes corporativas o VPN. En ese caso usá *Escuchar el video*. Si querés seguir usando la descarga, podés pasarle a yt-dlp las cookies de un navegador donde tengas YouTube abierto:
  ```powershell
  $env:YTDLP_COOKIES_FROM_BROWSER = "firefox"; node server.js
  ```
  Ojo: eso le da a yt-dlp acceso a tus cookies de ese navegador.
- Descargar contenido de YouTube puede ir contra sus Términos de Servicio. Usalo para práctica personal y con material que tengas derecho a usar.
- Videos de hasta 15 minutos.

## Cómo está hecho

```
server.js          Servidor local sin dependencias (Node). Sirve la app y baja audio con yt-dlp.
iniciar.bat        Lanzador para Windows.
public/
  index.html       Interfaz.
  app.js           Captura/decodificación de audio, IA, armado de pasos, teclado y sintetizador.
  style.css        Estilos.
  model/           Modelo de basic-pitch (Apache-2.0, ver LICENSE-basic-pitch.txt).
bin/               yt-dlp (se descarga solo, no se versiona).
cache/             Audio descargado (no se versiona).
```

El servidor escucha solo en `127.0.0.1` (no se expone a la red).

## Créditos

- [basic-pitch](https://github.com/spotify/basic-pitch-ts) — Spotify, licencia Apache-2.0. El modelo está incluido en `public/model/`.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — Unlicense. Se descarga en el primer arranque.
- [TensorFlow.js](https://github.com/tensorflow/tfjs) — Apache-2.0, cargado desde CDN.
