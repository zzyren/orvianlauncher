# Orvian Launcher
<<<<<<< HEAD

Aplicación Electron + React + TypeScript para Windows, con una frontera IPC aislada entre interfaz y procesos Node. La marca, shell visual, validación de manifiesto, clasificación de ficheros oficiales, planificación incremental, comprobación SHA-256 y guardado de RAM están iniciados.

## Requisitos y ejecución

- Windows 10/11 x64
- Node.js LTS (20 o posterior) y npm
- `npm install`, `npm run dev`
- `npm test`, `npm run build`, `npm run dist:win`

La configuración de electron-builder está preparada para NSIS por usuario. La publicación de actualizaciones apunta al repositorio GitHub `zzyren/orvian-launcher`; antes de publicar hay que crear ese repositorio, configurar credenciales de publicación, firma de código y un feed estable.

## Situación de fuentes del modpack

El archivo entregado `Orvian.mrpack` sí pudo inspeccionarse localmente. `modrinth.index.json` confirma Orvian `1.0.0`, Minecraft `1.20.1`, Forge `47.4.23`, 75 ficheros remotos y 692 entradas ZIP incluyendo overrides. Las entradas de mod tienen URL de CDN Modrinth y hashes SHA-1/SHA-512; el formato no incluye SHA-256, por lo que el empaquetador debe calcularlo al descargar o extraer cada objeto antes de publicar el manifiesto propio. No apareció dependencia Fabric/NeoForge en el index.

El `.mrpack` contiene overrides de `config/`, pero también estado local/cache que no se debe distribuir como defaults: `.bobby` con regiones de mundo del servidor, `modernfix/structureCacheV1`, waypoints/mapas de Xaero, `servers.dat`, cachés de usuario y logs. El importador del pack debe filtrar estos datos volátiles y verificar las licencias antes de incluir mods. La rama `main` del repo todavía solo contiene README y licencia; existe además la release `v0.1.5-alpha` con ZIP monolítico de 1,485,175,284 bytes. En Modrinth no se encuentra proyecto público `orvian`.

El ZIP de 1.48 GB no se adopta como paquete incremental ni se extrae a rutas de usuario: se necesita inspeccionarlo, confirmar la licencia/distribución de cada mod y convertir la instancia a manifiesto propio con SHA-256 por fichero. Hasta entonces no existe un `orvian-manifest.json` de producción deliberadamente: inventar Forge, sus ficheros o licencias haría insegura la instalación. La versión exacta de Forge no está indicada por metadata pública verificable.

## Manifiesto

`src/shared/manifest.ts` valida esquema, versión SemVer básica, URLs HTTPS, SHA-256, paths relativos sin traversal, duplicados y políticas de inmutabilidad. `decideFileSync` siembra configs oficiales en la instalación inicial; tras eso compara el hash local con el último hash oficial. Si coincide, actualiza al nuevo default; si el usuario editó su config, la conserva y coloca el nuevo default como pendiente separado para recuperación/revisión. Ficheros personales no listados nunca se eliminan. No admite ejecutar scripts/archivos del manifiesto. Cuando se publique, el manifiesto debe quedar versionado en un GitHub Release (o una URL CDN inmutable) y solo incluir archivos con redistribución permitida. Los archivos personales pueden vivir en `mods/user`, `shaderpacks/user`, `resourcepacks/user` y en `config/` con esta política de actualización.

## Bloqueos previos a una beta instalable

1. Generar y publicar el manifiesto versionado desde `Orvian.mrpack`, excluir los datos locales/cachés identificados y auditar licencias/derechos de redistribución.
2. Registrar la aplicación pública de Microsoft/Xbox/Minecraft OAuth, configurar redirect URI y validar el flujo completo de entitlement. Nunca pedir/guardar contraseñas.
3. Integrar y verificar las APIs actuales de `@xmcl/user`, `@xmcl/installer` y `@xmcl/core` en el proceso main; resolver runtimes Java 17, instalación/diagnóstico de Minecraft y Forge, lanzamiento, cierre y crash.
4. Crear repositorio de releases del launcher, firmar instalador/actualizaciones y probar en Windows limpio.

La pantalla expone esos pasos como no configurados; los IPC actuales responden con un estado explícito y no simulan instalación, autenticación ni lanzamiento. No distribuir como producto final hasta completar estos requisitos.

## Licencias

El core de XMCL se publica bajo MIT según el repositorio. Auditar licencias de cada dependencia y de cada mod, respetar atribuciones, y no redistribuir mods que no permitan distribución directa. Las credenciales/token no deben escribirse en logs; incorporar almacenamiento seguro del sistema operativo antes de persistir sesión Microsoft.
=======
Custom launcher developed with [Antigravity](https://antigravity.google/) and [Claude Code](https://claude.ai/code) for the private Orvian server.

This launcher automatically downloads and manages the official modpack from the OrvianModpack repository, ensuring all players have the correct setup with minimal effort.

Designed exclusively for a friends-only environment, it provides a simple, consistent, and streamlined way to join and play on the server.
>>>>>>> 3aff7d1f7c02e70a43612f5bb5e6c571ab21d113
