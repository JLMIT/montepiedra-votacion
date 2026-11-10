# Votación Montepiedra

App web para votar por alícuotas en la asamblea de copropietarios del Condominio Montepiedra.
Publicada en https://montepiedra-f6ce2.web.app (Firebase Hosting + Firestore, plan gratuito).

- `public/`: la app (HTML, CSS, JavaScript). `unidades.js` tiene las 200 propiedades y su alícuota.
- `firestore.rules`: reglas de seguridad. Validan en el servidor el código por propiedad, el uso único del código,
  un voto por propiedad y tema, y que solo la administración lea votos antes del cierre.
- `scripts/rules.test.mjs`: pruebas de esas reglas; corren en el emulador antes de cada publicación.
- `scripts/seed.mjs` y `seed/`: datos iniciales (administradores, configuración). Solo crean lo que falta.
- `.github/workflows/publicar.yml`: cada push a `main` prueba las reglas y, si pasan, publica.

Credencial: cuenta de servicio de Firebase guardada solo como secreto de GitHub `FIREBASE_SERVICE_ACCOUNT`
(roles Administrador de Firebase y Consumidor de Service Usage). Nunca se sube al repositorio.

Ingreso: votantes de forma anónima (sin cuenta) y luego inscriben su propiedad con su código.
Administración: cuentas de Google registradas en la colección `admins`.
