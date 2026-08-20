# Guía de despliegue — pasar KDD Portal de mock a real

Checklist completo para conectar la extensión con Google. Al terminar,
en VS Code solo hay que rellenar **dos ajustes** (no hace falta
recompilar nada): `kddPortal.appsScriptUrl` y `kddPortal.emailUsuario`,
y desactivar `kddPortal.modoMock`.

---

## 1. Qué necesitamos en Google (resumen)

| Pieza | Cuántas | Para qué |
|---|---|---|
| **Spreadsheet «KDD Portal»** | 1 (nuevo) | Base de datos del portal: hojas `Config`, `Usuarios`, `Formaciones`, `Asistentes` (las crea `setup()`). |
| **Spreadsheet del informe TRA** | 1 (ya existe) | `1gFNF-N5IXBwjTaUpH27BzhZ0fj-b1plkzkps1e68Vb0`, hoja `PORTAL`. Solo lectura; `tra.gs` ya apunta a él. |
| **Proyecto de Apps Script** | 1 (nuevo) | Los 6 archivos de `backend/` desplegados como Web App. |
| **Google Groups** | 1 por equipo (4) | El «chat» de cada equipo (pueden ser groups ya existentes). |
| **Carpetas de Drive (KB)** | 1 por equipo (4) | Los documentos de la Knowledge Base de cada equipo. |
| **Calendario compartido** | 1 del área (opcional: 1 por equipo) | Los eventos de las formaciones. |

## 2. Spreadsheet «KDD Portal» (la BD del portal)

**Vía rápida (recomendada): importar la plantilla.** En
`backend/plantilla/kdd-portal-sheets.xlsx` está el spreadsheet ya
montado (4 hojas + hoja LEEME con instrucciones y celdas a rellenar en
amarillo). En Google Sheets: crear hoja de cálculo vacía → Archivo →
Importar → Subir → «Reemplazar hoja de cálculo». Con esta vía **no hace
falta ejecutar `setup()`** — las hojas ya existen. Copia el ID del
spreadsheet (entre `/d/` y `/edit` en la URL).

**Vía manual:** crea un Sheets vacío y deja que `setup()` (paso 3) cree
las hojas. En ambos casos, las dos hojas a rellenar a mano:

   **`Config`** — un equipo por fila (el corazón de la configuración):

   | TeamId | Nombre | GroupEmail | KbDriveFolderId | CalendarId |
   |---|---|---|---|---|
   | `front-office` | Front Office (Murex) | grupo del equipo | ID carpeta Drive KB | vacío = usa el del área |
   | `liquidez` | Liquidez y Pagos | … | … | |
   | `riesgos` | Riesgos y Límites | … | … | |
   | `back-office` | Back Office y Conciliación | … | … | |

   ⚠️ Los `TeamId` deben coincidir con los ids de `TEAMS` en
   `media/main.js` (front-office, liquidez, riesgos, back-office). Si se
   añaden equipos nuevos, hay que darlos de alta en ambos sitios.

   **`Usuarios`** — quién pertenece a qué equipo (decide qué KB completa
   ve cada persona):

   | Email | Equipo |
   |---|---|
   | tu.email@tudominio.com | front-office |

   **`Formaciones`** y **`Asistentes`**: las rellena la aplicación, no
   tocarlas (solo mirar).

## 3. Proyecto de Apps Script (uno solo)

1. [script.google.com](https://script.google.com) → «Nuevo proyecto».
2. Crea un archivo por cada `.gs` de `backend/` y pega su contenido:
   - `router.gs` — doGet/doPost y tabla de acciones
   - `config.gs` — CONFIG + hojas Config/Usuarios + `setup()`
   - `chat.gs` — chat ↔ correo del Google Group (caché 15 s)
   - `formaciones.gs` — Sheets + Calendar + aviso al grupo
   - `kb.gs` — índice/descarga de la KB desde Drive
   - `tra.gs` — informe TRA (ya apunta al Sheets real)
3. Configuración del proyecto → activa «Mostrar el archivo de manifiesto
   appsscript.json» y pega el contenido de `backend/appsscript.json`
   (define los scopes OAuth: Sheets, Calendar, Gmail, Drive readonly).
4. En `config.gs` rellena `CONFIG.SPREADSHEET_ID` (paso 2) y
   `CONFIG.CALENDAR_ID` (ID del calendario del área; en Google Calendar:
   configuración del calendario → «ID de calendario»).
5. Ejecuta una vez la función **`setup()`** desde el editor (botón
   ▶ Ejecutar). La primera vez pedirá autorizar todos los permisos —
   acéptalos con la cuenta que vaya a «ejecutar» la Web App. `setup()`
   crea las 4 hojas con cabeceras y filas de ejemplo.
6. Rellena las hojas `Config` y `Usuarios` (paso 2).
7. **Implementar → Nueva implementación → Aplicación web**:
   - «Ejecutar como»: **tú** (la cuenta propietaria — sus permisos de
     Gmail/Drive/Calendar son los que usará el backend).
   - «Quién tiene acceso»: **cualquier usuario de tu dominio** (o
     «Cualquier persona» si el dominio no lo permite; valorar el riesgo).
   - Copia la **URL que termina en `/exec`**.

> Cada vez que cambies el código del proyecto: Implementar → Gestionar
> implementaciones → editar → «Nueva versión». La URL /exec no cambia.

## 4. Groups, Drive y Calendar

- **Groups**: un grupo por equipo (o reutilizar los existentes). La
  cuenta que ejecuta la Web App debe **ser miembro** (para leer los
  hilos con GmailApp) y **poder publicar** (para enviar). Apunta cada
  email de grupo en la hoja `Config`.
- **Drive (KB)**: una carpeta por equipo con la documentación (Google
  Docs, .md, .txt; subcarpetas permitidas). La cuenta ejecutora necesita
  al menos lectura. El **ID de carpeta** (lo que sigue a `/folders/` en
  la URL) va en `Config.KbDriveFolderId`.
- **Calendar**: un calendario compartido del área (o por equipo, columna
  `CalendarId`). La cuenta ejecutora necesita permiso «Hacer cambios en
  eventos».
- **Informe TRA**: la cuenta ejecutora necesita lectura del spreadsheet
  del informe.

## 5. Verificación del backend (antes de tocar VS Code)

Abre en el navegador (con tu sesión de Google):

```
<URL/exec>?action=ping                         → {"ok":true,"pong":"…"}
<URL/exec>?action=getUserInfo&email=TU_EMAIL   → {"ok":true,"team":"front-office"}
<URL/exec>?action=getFormaciones               → {"ok":true,"formaciones":[]}
<URL/exec>?action=getChat&team=front-office    → {"ok":true,"messages":[…]}
<URL/exec>?action=getKbIndex&team=front-office → {"ok":true,"files":[…]}
<URL/exec>?action=getTra                       → {"ok":true,"rows":[…]}
```

Si algo devuelve `{"ok":false,…}`, el campo `error` dice qué falta
(hoja sin crear, equipo sin configurar, permiso sin conceder…).

## 6. Conectar la extensión (sin recompilar)

En VS Code: `Ctrl+,` → busca **KDD Portal**:

1. `kddPortal.appsScriptUrl` → la URL `/exec`.
2. `kddPortal.emailUsuario` → tu email corporativo (debe estar en la
   hoja `Usuarios`).
3. `kddPortal.nombreUsuario` → opcional.
4. Desmarca `kddPortal.modoMock`.

Reabre el panel: la insignia pasará de «MODO DEMO · vX» a
**«CONECTADO · vX»**. El polling del chat baja a 20 s en real (cuotas
de GmailApp).

## 6bis. Arranque con UN solo equipo

Para el piloto basta con configurar `front-office` (o el equipo que
elijas, respetando su TeamId):

- Hoja `Config`: solo su fila con GroupEmail y KbDriveFolderId; deja las
  otras tres filas con TeamId/Nombre y el resto vacío.
- Hoja `Usuarios`: las personas del piloto, todas con ese equipo.
- Solo hace falta 1 Google Group y 1 carpeta de Drive.
- En la extensión seguirán viéndose los 4 equipos: en modo real, el chat
  de los no configurados mostrará «Sin conexión» (su KB sigue simulada).
  Es el comportamiento esperado del despliegue por fases; al incorporar
  cada equipo, basta con completar su fila en `Config`.

## 7. Qué queda simulado incluso en modo real (hitos siguientes)

1. **Chat de la Knowledge Base**: responde con el mock hasta el hito
   Copilot — sincronizar la KB de Drive a local (`getKbIndex`/`getKbFile`
   ya están en el backend) y responder con `vscode.lm` (vendor
   'copilot') usando `backend/instrucciones-kb-copilot.md`. Requiere
   GitHub Copilot instalado en el VS Code del usuario.
2. Los **contadores de docs de la KB** en tarjetas/cabeceras (kbDocs de
   `TEAMS` en main.js) — pasarán a salir de `getKbIndex` en ese hito.
3. Los avisos «(simulado)» de la interfaz se retirarán entonces.
