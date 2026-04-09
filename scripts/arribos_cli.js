/**
 * scripts/arribos_cli.js
 *
 * Puente entre el bot y tu flujo real:
 * - Toma --parada y --linea
 * - Clona y rellena un XML temporal desde PAYLOAD_TEMPLATE (.env)
 * - Ejecuta tu PowerShell PS_SCRIPT para generar un JSON
 * - Normaliza ese JSON a {arribos:[], vehiculos:[]}
 *
 * Uso:
 *    node scripts/arribos_cli.js --parada 0063 --linea 329
 */

const fs = require('fs');

// 1. Leer argumentos de la consola
function parseArgs() {
  const a = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i], v = process.argv[i + 1];
    if (k === '--parada' || k === '-p') { a.parada = String(v || '').trim(); i++; }
    else if (k === '--linea' || k === '-l') { a.linea = String(v || '').trim(); i++; }
  }
  return a;
}

const { parada, linea } = parseArgs();
if (!parada || !linea) { 
  console.error('Faltan parámetros: --parada y --linea'); 
  process.exit(1); 
}

// 2. Armar el XML (Payload)
const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:tns="http://clsw.smartmovepro.net/">
  <soap12:Body>
    <tns:RecuperarProximosArribos>
      <tns:usuario>WEB.PERGAMINO</tns:usuario>
      <tns:clave>PAR.SW.PERGAMINO</tns:clave>
      <tns:identificadorParada>${parada}</tns:identificadorParada>
      <tns:codigoLineaParada>${linea}</tns:codigoLineaParada>
      <tns:codigoAplicacion>24</tns:codigoAplicacion>
      <tns:localidad>PERGAMINO</tns:localidad>
      <tns:isSublinea>false</tns:isSublinea>
      <tns:isSoloAdaptados>false</tns:isSoloAdaptados>
    </tns:RecuperarProximosArribos>
  </soap12:Body>
</soap12:Envelope>`;

// 3. Consultar la API directamente desde Node
async function fetchArribos() {
  try {
    // Nota: fetch nativo requiere Node.js v18 o superior
    const res = await fetch('http://clswbsas.smartmovepro.net/ModuloParadas/SWParadas.asmx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8; action="http://clsw.smartmovepro.net/RecuperarProximosArribos"'
      },
      body: xmlBody
    });

    const text = await res.text();
    
    // Extraer el JSON de adentro de la respuesta XML
    const match = text.match(/<RecuperarProximosArribosResult>(.*?)<\/RecuperarProximosArribosResult>/);

    if (!match) {
      console.error("No se encontró JSON en la respuesta SOAP");
      process.exit(1);
    }

    const rawJson = JSON.parse(match[1]);

    // 4. Normalizar los datos
    function toMinutes(arriboText) {
      if (!arriboText) return null;
      const m = String(arriboText).match(/(\d+)\s*min/i);
      return m ? parseInt(m[1], 10) : null;
    }

    function normalize(obj) {
      const out = { arribos: [], vehiculos: [] };
      const list = obj.arribos || obj.Arribos || [];
      if (!Array.isArray(list)) return out;

      out.arribos = list.map(a => {
        const minutos = toMinutes(a.Arribo);
        const lat = a.Latitud != null ? Number(a.Latitud) : null;
        const lon = a.Longitud != null ? Number(a.Longitud) : null;
        return {
          minutos,
          hora: a.Arribo || null,
          ramal: a.DescripcionLinea || null,
          destino: a.DescripcionBandera || null,
          interno: a.IdentificadorCoche || null,
          lat, lon,
          actualizado: a.UltimaFechaHoraGPS || null,
          vehiculo_maps: (lat!=null && lon!=null) ? `https://www.google.com/maps?q=${lat},${lon}` : null
        };
      });

      out.vehiculos = list.filter(v => v.Latitud != null && v.Longitud != null).map(v => {
          const lat = Number(v.Latitud), lon = Number(v.Longitud);
          return {
            interno: v.IdentificadorCoche || null,
            ramal: v.DescripcionLinea || null,
            lat, lon,
            actualizado: v.UltimaFechaHoraGPS || null,
            maps: `https://www.google.com/maps?q=${lat},${lon}`
          };
      });

      return out;
    }

    const normalized = normalize(rawJson);
    
    // Devolver el JSON a bot.js
    process.stdout.write(JSON.stringify(normalized));

  } catch (error) {
    console.error("Error al obtener los datos:", error);
    process.exit(1);
  }
}

fetchArribos();