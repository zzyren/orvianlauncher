# Publicar una versión del launcher

El launcher se publica con un tag `vX.Y.Z`. El workflow `release.yml` comprueba que el tag coincide con la
versión de `package.json`, ejecuta lint, tests y pruebas E2E, construye el instalador y lo sube a GitHub
**como borrador**. Ningún jugador lo recibe (ni por el actualizador automático) hasta que lo publiques a mano.

## Pasos

1. Sube `version` en `package.json` y haz commit (`chore: release X.Y.Z`).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Espera a que termine el workflow. Si falla en lint, tests o E2E no se crea nada.
4. En GitHub › Releases abre el borrador `vX.Y.Z`. Debe contener `orvian-launcher-setup-X.Y.Z.exe`,
   `…exe.blockmap` y `latest.yml`.
5. Haz el **smoke test** de abajo con ese instalador.
6. Pulsa **Publish release**. A partir de ese momento los launchers instalados se actualizan.

Si algo sale mal después de publicar: marca la release como borrador de nuevo (el actualizador deja de verla)
y publica una versión corregida con número mayor. No se puede bajar de versión (`allowDowngrade` está desactivado).

## Smoke test manual en Windows

Lo que las pruebas automáticas no pueden comprobar (necesita Windows, una cuenta de Minecraft Java y el servidor):

- [ ] Instalar sobre la versión anterior: se conservan la sesión, la instancia y los ajustes.
- [ ] Primera instalación en una máquina limpia: Java, Minecraft, Forge y modpack, con progreso por pasos.
- [ ] Iniciar sesión con Microsoft y cancelar a mitad de camino desde el launcher.
- [ ] «Jugar» abre Minecraft; el multijugador conecta; «Jugar en el servidor» entra directo.
- [ ] Sesión de más de 24 h: el multijugador sigue funcionando (renovación silenciosa). Se puede forzar
      editando la caducidad guardada o esperando.
- [ ] Sin conexión (desconecta la red) con el modpack instalado: «Jugar sin conexión» arranca.
- [ ] Cortar la red a mitad de una actualización del modpack y reanudar: termina sin descargar de nuevo el zip.
- [ ] Provocar un fallo del juego (un mod incompatible en `mods/`): aparece el diálogo con el resumen y el informe.
- [ ] Cerrar el launcher con Minecraft abierto: pide confirmación. «Reiniciar y actualizar» está desactivado
      mientras se juega.
- [ ] Restablecer el launcher conserva los mundos; con el borrado explícito y la palabra escrita los elimina.
- [ ] SmartScreen: el instalador no está firmado todavía (ver «Pendiente del propietario»).

## Publicar una versión del modpack

Desde el panel **Admin** del propio launcher (solo cuentas de `ADMIN_UUIDS`). El orden de operaciones es
borrador → `modpack.zip` → `orvian-manifest.json` → publicar, así que ningún jugador ve un manifest sin su zip.

- Si la nueva versión del pack necesita un launcher más nuevo, indica «Launcher mínimo». **Publica antes el
  launcher nuevo** y espera a que los jugadores lo reciban.
- El token de GitHub debe ser *fine-grained*, limitado a `zzyren/orvianmodpack`, con **Contents: read and write**.

## Pendiente del propietario

Estas acciones no se pueden hacer desde el código:

1. **Aplicación propia de Azure.** El launcher usa el client ID público del launcher oficial de Mojang
   (`electron/config.ts` › `msClientId`). Microsoft pide a los launchers de terceros registrar su propia
   aplicación y solicitar acceso a la API de Minecraft. Cuando exista, cambia el ID (y el redirect si hace falta).
2. **Firma de código (Authenticode).** Sin certificado, SmartScreen avisa al instalar y no se verifica el
   editor. Con el certificado, configura `win.signtoolOptions` / `publisherName` en `package.json`.
3. **Historial de git.** Las rutas y nombres de jugador de `pack/overrides` y `.cache` siguen en el historial
   aunque ya no estén en el árbol. Purgarlo (`git filter-repo`) reescribe el historial y exige coordinar a todos
   los que tengan un clon: decisión del propietario.
4. **Dirección del servidor** (`payo.exaroton.me:25565`) y duración mínima de la splash (`minSplashMs`, 5 s):
   confirmar o cambiar en `electron/config.ts`. El manifest también puede llevar un bloque `server` para
   cambiar la dirección sin publicar un launcher nuevo.
