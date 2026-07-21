/************************************************************************
 * PIPELINE 3D ARGENPARTS — Apps Script para BBDD FOTOS 2026
 * ----------------------------------------------------------------------
 * INSTALACIÓN:
 *   1. Abrir el Google Sheet "BBDD FOTOS 2026"
 *   2. Extensiones > Apps Script > pegar TODO este archivo > Guardar
 *   3. Editar el bloque CONFIG de abajo (URL del webhook de n8n)
 *   4. Recargar el Sheet: aparece el menú "Pipeline 3D"
 *   5. Para el callback de n8n: Implementar > Nueva implementación >
 *      Aplicación web > Ejecutar como: Yo > Acceso: Cualquier usuario >
 *      copiar la URL y pegarla en el nodo "Callback a Sheet" de n8n
 *
 * FLUJO:
 *   Construir Cola 3D  ->  Importar prioridades  ->  Enviar lote a n8n
 *   n8n genera en Meshy, sube a S3 y reporta aquí vía doPost()
 ************************************************************************/

// ========================= CONFIG (EDITAR) =========================
var CONFIG = {
  N8N_WEBHOOK_URL: 'https://TU-INSTANCIA-N8N/webhook/meshy-3d',
  TOKEN_COMPARTIDO: 'CAMBIA-ESTE-TOKEN',   // mismo valor en n8n (seguridad básica)
  MIN_FOTOS: 4,          // mínimo de fotos para que un SKU sea elegible
  MAX_IMG_MESHY: 4,      // Meshy acepta máx. 4 imágenes por tarea
  TAMANO_LOTE: 5,        // SKUs por envío (controla consumo de créditos)
  // MODO PRUEBA: si la lista tiene SKUs, SOLO esos se envían a n8n.
  // Para operación normal, dejarla vacía: SOLO_SKUS: []
  SOLO_SKUS: ['P2100724'],
  HOJA_COLA: 'Cola 3D',
  HOJA_PRIORIDADES: 'Prioridades',
  HOJAS_EXCLUIDAS: ['Presentación', 'Cola 3D', 'Prioridades']
};
// ===================================================================

var COLS = {
  PRIORIDAD: 1, SKU: 2, LINEA: 3, NUM_FOTOS: 4, ESTADO: 5,
  TAREA_MESHY: 6, GLB_S3: 7, USDZ_S3: 8, THUMBS_QA: 9,
  VIDEO_MASTER: 10, PUBS_MELI: 11, VARIANTE_VIDEO: 12,
  NOTAS: 13, ACTUALIZADO: 14, FOTOS: 15
};

var ENCABEZADOS = [
  'Prioridad', 'SKU', 'Línea', 'Núm. fotos', 'Estado',
  'Tarea Meshy (ID)', 'GLB en S3', 'USDZ en S3', 'Thumbnails QA',
  'Video master', 'Publicaciones MeLi (IDs, separadas por coma)',
  'Variante de video por publicación (pendiente de especificación)',
  'Notas', 'Última actualización', 'Fotos (URLs)'
];

// Estados del ciclo de vida
var ESTADOS = {
  PENDIENTE: 'Pendiente',
  ENVIADO: 'Enviado a n8n',
  GENERANDO: 'Generando en Meshy',
  QA: 'En revisión visual (QA)',
  APROBADO: 'Aprobado',
  RECHAZADO: 'Rechazado',
  ERROR: 'Error'
};

// ============================ MENÚ ============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Pipeline 3D')
    .addItem('1. Construir / actualizar Cola 3D', 'construirCola')
    .addItem('2. Importar prioridades (hoja "Prioridades")', 'importarPrioridades')
    .addItem('3. Enviar siguiente lote a n8n', 'enviarLote')
    .addSeparator()
    .addItem('Reenviar SKUs seleccionados', 'reenviarSeleccion')
    .addItem('Instrucciones', 'mostrarInstrucciones')
    .addToUi();
}

// ================== 1. CONSTRUIR LA COLA ==================
// Recorre todas las hojas de la BBDD, agrupa fotos por SKU
// (quita sufijos _2, _3...) y llena/actualiza la hoja Cola 3D
// conservando el estado de los SKUs ya procesados.
function construirCola() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mapa = {}; // sku -> {linea, fotos:[]}

  ss.getSheets().forEach(function (hoja) {
    var nombre = hoja.getName().trim();
    if (CONFIG.HOJAS_EXCLUIDAS.indexOf(nombre) !== -1) return;
    var datos = hoja.getDataRange().getValues();
    for (var i = 1; i < datos.length; i++) {
      var foto = datos[i][2]; // col C: Nombre de la foto
      var url = datos[i][4];  // col E: URL FINAL
      if (!foto || !url) continue;
      var base = String(foto).trim()
        .replace(/_\d+$/, '')   // quita sufijo _2, _3...
        .replace(/\.\d+$/, ''); // quita sufijo .0
      if (!mapa[base]) mapa[base] = { linea: nombre, fotos: [] };
      mapa[base].fotos.push(String(url).trim());
    }
  });

  // Estado previo (para no pisar SKUs ya procesados)
  var cola = obtenerHojaCola_();
  var previos = {};
  var datosPrev = cola.getDataRange().getValues();
  for (var r = 1; r < datosPrev.length; r++) {
    if (datosPrev[r][COLS.SKU - 1]) previos[datosPrev[r][COLS.SKU - 1]] = datosPrev[r];
  }

  // Construir filas: solo SKUs con MIN_FOTOS o más
  var filas = [];
  Object.keys(mapa).forEach(function (sku) {
    var info = mapa[sku];
    if (info.fotos.length < CONFIG.MIN_FOTOS) return;
    var prev = previos[sku];
    filas.push([
      prev ? prev[COLS.PRIORIDAD - 1] : 9999,
      sku,
      info.linea,
      info.fotos.length,
      prev ? prev[COLS.ESTADO - 1] : ESTADOS.PENDIENTE,
      prev ? prev[COLS.TAREA_MESHY - 1] : '',
      prev ? prev[COLS.GLB_S3 - 1] : '',
      prev ? prev[COLS.USDZ_S3 - 1] : '',
      prev ? prev[COLS.THUMBS_QA - 1] : '',
      prev ? prev[COLS.VIDEO_MASTER - 1] : '',
      prev ? prev[COLS.PUBS_MELI - 1] : '',
      prev ? prev[COLS.VARIANTE_VIDEO - 1] : '',
      prev ? prev[COLS.NOTAS - 1] : '',
      prev ? prev[COLS.ACTUALIZADO - 1] : '',
      info.fotos.join(', ')
    ]);
  });

  // Ordenar: prioridad asc, luego núm. fotos desc
  filas.sort(function (a, b) {
    return (a[0] - b[0]) || (b[3] - a[3]);
  });

  cola.clearContents();
  cola.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS]).setFontWeight('bold');
  if (filas.length) cola.getRange(2, 1, filas.length, ENCABEZADOS.length).setValues(filas);
  cola.setFrozenRows(1);

  SpreadsheetApp.getUi().alert('Cola 3D construida: ' + filas.length +
    ' SKUs elegibles (con ' + CONFIG.MIN_FOTOS + '+ fotos).');
}

// ================== 2. IMPORTAR PRIORIDADES ==================
// Crea una hoja "Prioridades" y pega ahí los SKUs en la columna A,
// en el orden deseado (el 1º es el más prioritario). Luego ejecuta esto.
function importarPrioridades() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hojaP = ss.getSheetByName(CONFIG.HOJA_PRIORIDADES);
  if (!hojaP) {
    ss.insertSheet(CONFIG.HOJA_PRIORIDADES).getRange('A1').setValue('SKU (uno por fila, en orden de prioridad)');
    SpreadsheetApp.getUi().alert('Se creó la hoja "' + CONFIG.HOJA_PRIORIDADES +
      '". Pega ahí tu lista de SKUs (columna A, desde A2) y vuelve a ejecutar.');
    return;
  }
  var lista = hojaP.getRange(2, 1, Math.max(hojaP.getLastRow() - 1, 1), 1).getValues()
    .map(function (f) { return String(f[0]).trim(); })
    .filter(function (s) { return s; });

  var orden = {};
  lista.forEach(function (sku, i) { orden[sku] = i + 1; });

  var cola = obtenerHojaCola_();
  var datos = cola.getDataRange().getValues();
  var noEncontrados = [];
  for (var r = 1; r < datos.length; r++) {
    var sku = datos[r][COLS.SKU - 1];
    datos[r][COLS.PRIORIDAD - 1] = orden[sku] || 9999;
  }
  lista.forEach(function (sku) {
    var existe = datos.some(function (f) { return f[COLS.SKU - 1] === sku; });
    if (!existe) noEncontrados.push(sku);
  });

  // Reordenar y reescribir
  var cuerpo = datos.slice(1).sort(function (a, b) { return a[0] - b[0]; });
  cola.getRange(2, 1, cuerpo.length, ENCABEZADOS.length).setValues(cuerpo);

  var msg = 'Prioridades aplicadas a ' + lista.length + ' SKUs.';
  if (noEncontrados.length) {
    msg += '\n\nNO elegibles o inexistentes en la cola (revisar: puede que tengan menos de ' +
      CONFIG.MIN_FOTOS + ' fotos):\n' + noEncontrados.join(', ');
  }
  SpreadsheetApp.getUi().alert(msg);
}

// ================== 3. ENVIAR LOTE A N8N ==================
function enviarLote() {
  var cola = obtenerHojaCola_();
  var datos = cola.getDataRange().getValues();
  var enviados = 0;

  for (var r = 1; r < datos.length && enviados < CONFIG.TAMANO_LOTE; r++) {
    if (datos[r][COLS.ESTADO - 1] !== ESTADOS.PENDIENTE) continue;
    // MODO PRUEBA: si SOLO_SKUS tiene elementos, ignora todo lo demás
    if (CONFIG.SOLO_SKUS.length &&
        CONFIG.SOLO_SKUS.indexOf(String(datos[r][COLS.SKU - 1]).trim()) === -1) continue;
    var ok = enviarFila_(cola, r + 1, datos[r]);
    if (ok) enviados++;
  }
  var aviso = enviados + ' SKUs enviados a n8n (lote máx: ' + CONFIG.TAMANO_LOTE + ').';
  if (CONFIG.SOLO_SKUS.length) {
    aviso += '\n\nMODO PRUEBA ACTIVO: solo se envían ' + CONFIG.SOLO_SKUS.join(', ') +
      '. Para operación normal, vacía SOLO_SKUS en el CONFIG.';
  }
  SpreadsheetApp.getUi().alert(aviso);
}

// Reenvía las filas actualmente seleccionadas (para errores o reintentos)
function reenviarSeleccion() {
  var cola = obtenerHojaCola_();
  var rangos = cola.getActiveRangeList();
  if (!rangos) return;
  var enviados = 0;
  rangos.getRanges().forEach(function (rango) {
    for (var r = rango.getRow(); r <= rango.getLastRow(); r++) {
      if (r < 2) continue;
      var fila = cola.getRange(r, 1, 1, ENCABEZADOS.length).getValues()[0];
      if (enviarFila_(cola, r, fila)) enviados++;
    }
  });
  SpreadsheetApp.getUi().alert(enviados + ' SKUs reenviados.');
}

function enviarFila_(cola, numFila, fila) {
  var sku = fila[COLS.SKU - 1];
  var fotos = String(fila[COLS.FOTOS - 1]).split(',')
    .map(function (u) { return u.trim(); })
    .filter(function (u) { return u; });

  var payload = {
    token: CONFIG.TOKEN_COMPARTIDO,
    sku: sku,
    linea: fila[COLS.LINEA - 1],
    image_urls: seleccionarMejores_(fotos, CONFIG.MAX_IMG_MESHY)
  };

  try {
    var resp = UrlFetchApp.fetch(CONFIG.N8N_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 200 && resp.getResponseCode() < 300) {
      cola.getRange(numFila, COLS.ESTADO).setValue(ESTADOS.ENVIADO);
      cola.getRange(numFila, COLS.ACTUALIZADO).setValue(new Date());
      return true;
    }
    cola.getRange(numFila, COLS.NOTAS).setValue('HTTP ' + resp.getResponseCode() + ' al enviar a n8n');
    return false;
  } catch (e) {
    cola.getRange(numFila, COLS.NOTAS).setValue('Error de red: ' + e.message);
    return false;
  }
}

// Selecciona hasta N fotos distribuidas entre los ángulos disponibles
// (la primera siempre entra; el resto se toma espaciado uniformemente)
function seleccionarMejores_(fotos, n) {
  if (fotos.length <= n) return fotos;
  var out = [fotos[0]];
  var paso = (fotos.length - 1) / (n - 1);
  for (var i = 1; i < n; i++) out.push(fotos[Math.round(i * paso)]);
  return out;
}

// ================== CALLBACK DESDE N8N (Web App) ==================
// n8n hace POST aquí con: {token, sku, estado, task_id, glb_url,
//   usdz_url, thumbnails, video_url, error}
function doPost(e) {
  var out = { ok: false };
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.token !== CONFIG.TOKEN_COMPARTIDO) {
      return respuestaJson_({ ok: false, error: 'token inválido' });
    }
    var cola = obtenerHojaCola_();
    var datos = cola.getDataRange().getValues();
    for (var r = 1; r < datos.length; r++) {
      if (datos[r][COLS.SKU - 1] !== body.sku) continue;
      var fila = r + 1;
      if (body.estado) cola.getRange(fila, COLS.ESTADO).setValue(body.estado);
      if (body.task_id) cola.getRange(fila, COLS.TAREA_MESHY).setValue(body.task_id);
      if (body.glb_url) cola.getRange(fila, COLS.GLB_S3).setValue(body.glb_url);
      if (body.usdz_url) cola.getRange(fila, COLS.USDZ_S3).setValue(body.usdz_url);
      if (body.thumbnails) cola.getRange(fila, COLS.THUMBS_QA).setValue(body.thumbnails);
      if (body.video_url) cola.getRange(fila, COLS.VIDEO_MASTER).setValue(body.video_url);
      if (body.error) cola.getRange(fila, COLS.NOTAS).setValue(body.error);
      cola.getRange(fila, COLS.ACTUALIZADO).setValue(new Date());
      out = { ok: true, sku: body.sku };
      break;
    }
    if (!out.ok) out.error = 'SKU no encontrado en la cola: ' + body.sku;
  } catch (err) {
    out.error = err.message;
  }
  return respuestaJson_(out);
}

// ================== AUXILIARES ==================
function obtenerHojaCola_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(CONFIG.HOJA_COLA);
  if (!hoja) {
    hoja = ss.insertSheet(CONFIG.HOJA_COLA);
    hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS]).setFontWeight('bold');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function respuestaJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function mostrarInstrucciones() {
  SpreadsheetApp.getUi().alert(
    'FLUJO:\n' +
    '1. "Construir Cola 3D": detecta los SKUs con ' + CONFIG.MIN_FOTOS + '+ fotos.\n' +
    '2. Pega tus SKUs prioritarios en la hoja "Prioridades" (col A) y ejecuta "Importar prioridades".\n' +
    '3. "Enviar siguiente lote": manda ' + CONFIG.TAMANO_LOTE + ' SKUs Pendientes a n8n.\n' +
    'n8n genera el 3D en Meshy, lo sube a S3 y actualiza esta hoja solo.\n\n' +
    'MELI (tentativo): llena la columna "Publicaciones MeLi" con los IDs de\n' +
    'publicación separados por coma; la columna "Variante de video" queda\n' +
    'pendiente de tus especificaciones de edición.'
  );
}
