# Orvian Launcher

Launcher de escritorio para Windows del servidor privado **Orvian**. Con un solo botón instala Java, Minecraft
1.20.1, Forge 47.4.23 y el modpack de la comunidad, lo mantiene actualizado y lanza el juego.

- **Plataforma:** Windows x64. Está hecho con Electron 44, React 18, Vite y TypeScript.
- **Uso previsto:** un launcher privado para un grupo pequeño de jugadores. No es un launcher genérico.
- **Idioma de la interfaz:** español.

## Qué hace

| Función | Detalle |
|---|---|
| Cuenta | Inicio de sesión con Microsoft. La sesión se renueva sola antes de jugar; los tokens se guardan cifrados con `safeStorage`. |
| Instalación | Java 17 (Adoptium, verificado por SHA-256), Minecraft, Forge, librerías y assets, con progreso por pasos y por bytes. |
| Modpack | Se descarga de GitHub Releases. Cada archivo se verifica por SHA-256 y se escribe de forma atómica. Las configuraciones editadas por el jugador se conservan. |
| Sin conexión | Con el modpack ya instalado se puede jugar sin red. |
| Servidor | Estado en vivo (en línea, jugadores, latencia) y botón «Jugar en el servidor». |
| Novedades | Cambios de la versión actual y de las anteriores, tomados de las releases del modpack. |
| Mods | Lista de mods instalados e instalación desde Modrinth y CurseForge, con verificación de hash. |
| Fallos del juego | Si Minecraft se cierra con error, muestra un resumen y abre el informe. |
| Diagnóstico | «Copiar diagnóstico» genera un texto sin tokens para pedir soporte. |
| Actualizaciones | El propio launcher se actualiza (`electron-updater`). Nunca se instala mientras se juega. |
| Admin | Panel para publicar versiones del modpack. Solo lo ven las cuentas autorizadas. |

## Requisitos para desarrollar

- Node.js 22 o superior y npm.
- Para empaquetar el instalador de Windows (`dist:win`), un equipo Windows. El resto funciona también en Linux y macOS.
- Para probar el juego de verdad: una cuenta de Minecraft Java.

## Comandos

```bash
npm ci               # instala dependencias
npm run dev          # compila el proceso main y abre el launcher con recarga en caliente
npm run lint         # ESLint + TypeScript (renderer y main)
npm test             # tests unitarios y de integración (Vitest)
npm run test:e2e     # compila y ejecuta las pruebas de extremo a extremo (Playwright + Electron)
npm run build        # compila main y renderer
npm run dist:win     # genera el instalador NSIS en release/
```

## Variables de desarrollo

Se leen solo en `electron/config.ts` y **se ignoran en las versiones empaquetadas**.

| Variable | Efecto |
|---|---|
| `ORVIAN_DATA_DIR` | Carpeta de datos en lugar de `%APPDATA%/Orvian`. |
| `ORVIAN_MANIFEST_URL` | URL alternativa del manifest del modpack. |
| `ORVIAN_PACK_REPO` | Repositorio alternativo `usuario/repo` para el modpack. |
| `ORVIAN_SERVER` | Servidor alternativo, `host` o `host:puerto`. |
| `ORVIAN_SPLASH_MS` | Duración mínima de la pantalla de inicio. |

## Configuración del producto

Las constantes están en `electron/config.ts`:

- Minecraft `1.20.1` y Forge `47.4.23`.
- Repositorio del modpack: `zzyren/orvianmodpack`.
- Servidor: `payo.exaroton.me:13133`. El manifest puede llevar un bloque `server` para cambiarlo sin publicar un launcher nuevo.
- Cuentas administradoras (`adminUuids`).
- Client ID de Microsoft: se usa el público del launcher de Mojang. Si Microsoft dejara de aceptarlo habría que registrar una aplicación propia de Azure.

## Dónde se guardan los datos

Todo vive en `%APPDATA%/Orvian`:

```
launcher/          cuenta cifrada, ajustes, caché del manifest, token de admin cifrado, logs/
runtime/java-17/   Java del launcher (no usa el Java del sistema)
common/            versiones, librerías y assets compartidos de Minecraft
instances/orvian/  la instancia del juego: mods, config, saves…
```

Los logs del launcher y del juego están en `launcher/logs/` y se redactan para no contener tokens.

## Arquitectura

Tres procesos de Electron, con `contextIsolation` y `sandbox` activos:

```
electron/            proceso main (Node): toda la lógica
  main.ts            arranque y ciclo de vida
  launcher.ts        raíz de composición: registra los handlers IPC
  state.ts           LauncherStore: única fuente de verdad del estado, empujado a las ventanas
  game/              instalación, lanzamiento, progreso y detección de fallos
  modpack/           manifest, sincronización y configuraciones pendientes
  auth.ts, java.ts, modManager.ts, publisher.ts, admin.ts, updater.ts
  serverStatus.ts, news.ts, diagnostics.ts, reset.ts
  net.ts, logger.ts, ipc.ts, config.ts, windows.ts, secretBox.ts
  preload.ts         puente seguro hacia la interfaz (solo `import type`)
src/shared/          código puro compartido: tipos, errores, manifest, integridad, estados
src/ui/              interfaz React: views/, components/, hooks/, styles/
e2e/, tests/         pruebas
```

Principios:

- **Un solo estado.** El main calcula una fase (`not-installed`, `ready`, `installing`, `running`, `crashed`…) y la empuja por el canal `launcher:state`. La ventana principal y la bandeja solo la dibujan; no hay sondeos.
- **Descargas verificadas.** Todo pasa por `net.ts`: archivo `.part`, comprobación de hash y renombrado atómico.
- **IPC validado.** Cada canal comprueba quién lo llama y valida los argumentos con Zod.
- **Errores tipados.** `OrvianError` lleva un código; `src/shared/errors.ts` los traduce a un título, una explicación y acciones de recuperación.
- **Sin secretos en la interfaz.** El token de GitHub del admin vive solo en el main, cifrado.

## Diseño

El sistema visual se llama «Observatorio»: superficies de tinta espacial, un único acento dorado tomado del emblema, tipografía Outfit autoalojada y movimiento contenido. Los tokens están en `src/ui/styles/tokens.css`; no se usan colores, z-index ni transiciones `all` fuera de ahí. Se respeta `prefers-reduced-motion`, hay foco visible en todo, diálogos accesibles y regiones de anuncio para lectores de pantalla.

## Pruebas

- **Vitest:** unitarias e integración, con servidores HTTP y TCP locales y directorios temporales reales.
- **Playwright:** arranca Electron sin empaquetar con datos temporales y comprueba los flujos críticos.
- **CI:** `.github/workflows/ci.yml` ejecuta lint, tests y build en cada push y PR; las pruebas E2E se ejecutan en los PR.
- **Lo que no se puede automatizar:** el inicio de sesión real de Microsoft, el arranque del juego y el instalador. Están en la lista manual de `RELEASING.md`.

## Publicar

- **Launcher:** crear un tag `vX.Y.Z` que coincida con la versión de `package.json`. El workflow `release.yml` lo construye y lo sube como **borrador**; nadie lo recibe hasta publicarlo a mano.
- **Modpack:** desde el panel Admin del launcher. El orden es borrador → `modpack.zip` → `orvian-manifest.json` → publicar, para que ningún jugador vea un manifest sin su zip.

Los pasos completos, la lista de pruebas manuales y las decisiones tomadas están en [`RELEASING.md`](RELEASING.md).

## Limitaciones conocidas

- El instalador **no está firmado**: Windows SmartScreen avisará al instalar («Más información › Ejecutar de todos modos»).
- El historial de git contiene rutas y nombres de jugador antiguos de la carpeta `pack/`. Si el repositorio se hiciera público, habría que purgarlo antes.
- CurseForge se consulta a través de un proxy no oficial (`api.curse.tools`); si desaparece, Modrinth sigue funcionando.
