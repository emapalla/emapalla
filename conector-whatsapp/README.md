# Conector WhatsApp · Bitácora de Perforación

Este programa queda prendido las 24 h en un servidor y hace tres cosas:

1. Se vincula a un número de WhatsApp como **dispositivo vinculado**, igual que WhatsApp Web, escaneando un QR una sola vez.
2. Guarda los mensajes de los **grupos de los rigs** que elijas: texto, textos de las fotos y las fotos de los partes.
3. Se los entrega a Claude como **conector**. La app Bitácora de Perforación los trae sola cada vez que la abrís, y Claude también los puede consultar desde cualquier chat.

> **Riesgo:** WhatsApp no autoriza oficialmente vincular programas de esta forma y puede suspender el número. Conviene usar un **número o chip dedicado** (por ejemplo un celular de la empresa), sumarlo a los grupos de los rigs y vincular ese número, no tu WhatsApp personal. El celular de ese número tiene que conectarse a internet al menos una vez cada 14 días para que la vinculación no se caiga.

## 1. Crear el servidor (Railway, unos 5 USD por mes)

1. Entrá a <https://railway.com> e iniciá sesión con tu cuenta de GitHub (`emapalla`).
2. **New Project → Deploy from GitHub repo →** elegí `emapalla/emapalla`.
3. En el servicio que se crea, abrí **Settings**:
   - **Source → Root Directory:** `conector-whatsapp`
   - **Source → Branch:** `claude/bitacora-perforacion`, o `main` si después se une a esa rama.
   - **Networking → Generate Domain:** crea una dirección del tipo `https://algo.up.railway.app`.
4. En **Variables** agregá:
   - `TOKEN` = una clave larga y secreta, de 16 caracteres o más, por ejemplo `perforacion-` seguido de 20 letras y números al azar. No la compartas.
5. Agregá un **volumen**: clic derecho en el servicio → **Attach Volume**, con Mount path `/data`. Ahí quedan la vinculación y los mensajes. Sin volumen se pierden en cada reinicio.
6. Esperá a que el despliegue quede en verde.

## 2. Vincular el WhatsApp

1. Abrí en el navegador `https://TU-DOMINIO.up.railway.app/admin?token=TU_TOKEN`.
2. En el celular del número dedicado: WhatsApp → ⋮ → **Dispositivos vinculados → Vincular un dispositivo**, y escaneá el QR que aparece en la página.
3. Cuando diga *Vinculado*, marcá los **grupos de los rigs** y tocá **Guardar selección**. Desde ese momento se guarda cada mensaje nuevo de esos grupos.

## 3. Conectarlo a Claude

1. En <https://claude.ai> → **Configuración → Conectores → Agregar conector personalizado**.
2. Nombre: **`Bitacora WhatsApp`**. Tiene que ser exactamente así, sin tilde, porque la app lo busca con ese nombre.
3. URL: `https://TU-DOMINIO.up.railway.app/mcp/TU_TOKEN`. La página de administración te la muestra lista para copiar.
4. Abrí la app Bitácora de Perforación. La primera vez te pide permiso para usar el conector; después sincroniza sola al abrirla.

## Qué puede hacer Claude con el conector

| Herramienta | Para qué sirve |
|---|---|
| `estado` | Si está vinculado, qué grupos se guardan y cuántos mensajes hay |
| `listar_grupos` | Todos los grupos del número |
| `vigilar_grupos` | Sumar o sacar grupos ("guardá también el grupo Eq 312") |
| `leer_mensajes` | Mensajes nuevos o filtrados por fecha, grupo o texto |
| `obtener_imagen` | La foto de un parte diario |

## Limitaciones

- **Audios:** se registran como `[audio]` pero todavía no se transcriben.
- **Historial anterior:** solo se guarda lo que llega después de vincular, más el historial reciente que WhatsApp manda al vincular.
- **Si se desvincula** (porque cerraste la sesión desde el teléfono o pasaron más de 14 días sin conexión): la página de administración vuelve a mostrar el QR.

## Probar en una computadora

```bash
cd conector-whatsapp
npm install
TOKEN=una-clave-de-prueba-larga DATA_DIR=./datos npm start
# abrir http://localhost:3000/admin?token=una-clave-de-prueba-larga
```
