# Conector WhatsApp · Bitácora de Perforación

Este programa queda prendido las 24 h en un servidor y hace tres cosas:

1. Se vincula a un número de WhatsApp como **dispositivo vinculado**, igual que WhatsApp Web, escaneando un QR una sola vez.
2. Guarda los mensajes de los **grupos de los rigs** que elijas: texto, textos de las fotos y las fotos de los partes.
3. Se los entrega a Claude como **conector**. La app Bitácora de Perforación los trae sola cada vez que la abrís, y Claude también los puede consultar desde cualquier chat.

> **Riesgo:** WhatsApp no autoriza oficialmente vincular programas de esta forma y puede suspender el número. Conviene usar un **número o chip dedicado** (por ejemplo un celular de la empresa), sumarlo a los grupos de los rigs y vincular ese número, no tu WhatsApp personal. El celular de ese número tiene que conectarse a internet al menos una vez cada 14 días para que la vinculación no se caiga.

## 1. Crear el servidor gratis (Oracle Cloud Always Free)

La guía paso a paso para personas sin experiencia técnica está en el documento *Bitácora de Perforación — Instalación y manual*. En resumen:

1. Creá una instancia Ubuntu 24.04 marcada **Always Free-eligible** (VM.Standard.A1.Flex con 1 OCPU y 6 GB, o VM.Standard.E2.1.Micro), con IP pública.
2. En **Advanced options → Management → cloud-init**, pegá este texto con tu clave:

   ```bash
   #!/bin/bash
   export CLAVE="TU-CLAVE-DE-16-O-MAS-CARACTERES"
   curl -fsSL https://raw.githubusercontent.com/emapalla/emapalla/claude/bitacora-perforacion/conector-whatsapp/instalar.sh | bash
   ```

3. En la **Security List** de la subred, abrí TCP 80 y 443 desde `0.0.0.0/0`.
4. A los 10 o 15 minutos el conector queda en `https://<ip-con-guiones>.sslip.io`, con HTTPS automático (Caddy) y una actualización diaria desde GitHub.

`instalar.sh` funciona en cualquier servidor Ubuntu o Debian con IP pública. Para otro proveedor, ejecutalo como root: `CLAVE=... bash instalar.sh`. Hay una alternativa paga con Docker: el `Dockerfile` y `railway.json` sirven para Railway o un servicio parecido, con un volumen en `/data` y la variable `TOKEN`.

## 2. Vincular el WhatsApp

1. Abrí en el navegador `https://TU-DOMINIO/admin?token=TU_CLAVE`.
2. En el celular del número dedicado: WhatsApp → ⋮ → **Dispositivos vinculados → Vincular un dispositivo**, y escaneá el QR que aparece en la página.
3. Cuando diga *Vinculado*, marcá los **grupos de los rigs** y tocá **Guardar selección**. Desde ese momento se guarda cada mensaje nuevo de esos grupos.

## 3. Conectarlo a Claude

1. En <https://claude.ai> → **Configuración → Conectores → Agregar conector personalizado**.
2. Nombre: **`Bitacora WhatsApp`**. Tiene que ser exactamente así, sin tilde, porque la app lo busca con ese nombre.
3. URL: `https://TU-DOMINIO/mcp/TU_CLAVE`. La página de administración te la muestra lista para copiar.
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
