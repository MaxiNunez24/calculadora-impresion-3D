/**
 * API de la calculadora 3D.
 *
 *   GET    /config                 configuración compartida entre dispositivos
 *   PUT    /config
 *   GET    /evaluaciones           historial
 *   PUT    /evaluaciones/:id
 *   DELETE /evaluaciones/:id
 *   GET    /precios                últimos precios guardados (no consulta PrintALot)
 *   POST   /precios/actualizar     consulta PrintALot (como mucho cada 10 minutos)
 *
 * Todo requiere "Authorization: Bearer <API_TOKEN>". Un cron semanal también actualiza los precios.
 */

const PRINTALOT_API = 'https://printalot.com.ar/wp-json/wc/store/v1/products?category=338&per_page=100';
const MINUTOS_ENTRE_ACTUALIZACIONES = 10;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin'), env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (!(await autorizado(request, env))) throw new HttpError(401, 'Token inválido');
      return json(await rutear(request, env), 200, cors);
    } catch (e) {
      return json({ error: e.message }, e.status || 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(actualizarPrecios(env, { forzar: true }));
  },
};

// ---------- HTTP ----------
function corsHeaders(origin, env) {
  const permitidos = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const headers = {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && permitidos.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function autorizado(request, env) {
  if (!env.API_TOKEN) throw new HttpError(500, 'Falta configurar el secreto API_TOKEN');
  const recibido = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  // Comparación en tiempo constante sobre los hashes, para no filtrar el token por timing
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(recibido)),
    crypto.subtle.digest('SHA-256', enc.encode(env.API_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function leerJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'El cuerpo no es JSON válido');
  }
}

async function rutear(request, env) {
  const [recurso, id] = new URL(request.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const metodo = request.method;

  if (recurso === 'config' && !id) {
    if (metodo === 'GET') {
      const fila = await env.DB.prepare('SELECT datos, actualizado FROM config WHERE id = 1').first();
      return fila ? { datos: JSON.parse(fila.datos), actualizado: fila.actualizado } : { datos: null, actualizado: null };
    }
    if (metodo === 'PUT') {
      const { datos, actualizado } = await leerJson(request);
      if (!datos || !actualizado) throw new HttpError(400, 'Faltan "datos" o "actualizado"');
      await env.DB.prepare(
        `INSERT INTO config (id, datos, actualizado) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET datos = excluded.datos, actualizado = excluded.actualizado`,
      ).bind(JSON.stringify(datos), actualizado).run();
      return { ok: true };
    }
  }

  if (recurso === 'evaluaciones') {
    if (metodo === 'GET' && !id) {
      const { results } = await env.DB.prepare('SELECT datos FROM evaluaciones ORDER BY fecha DESC').all();
      return results.map((r) => JSON.parse(r.datos));
    }
    if (metodo === 'PUT' && id) {
      const evaluacion = await leerJson(request);
      if (evaluacion.id !== id || !evaluacion.fecha) throw new HttpError(400, 'Evaluación inválida');
      await env.DB.prepare('INSERT OR REPLACE INTO evaluaciones (id, fecha, datos) VALUES (?1, ?2, ?3)')
        .bind(id, evaluacion.fecha, JSON.stringify(evaluacion)).run();
      return { ok: true };
    }
    if (metodo === 'DELETE' && id) {
      await env.DB.prepare('DELETE FROM evaluaciones WHERE id = ?1').bind(id).run();
      return { ok: true };
    }
  }

  if (recurso === 'precios') {
    if (metodo === 'GET' && !id) return listarPrecios(env);
    if (metodo === 'POST' && id === 'actualizar') return actualizarPrecios(env);
  }

  throw new HttpError(404, 'Ruta no encontrada');
}

// ---------- Precios de PrintALot ----------
async function listarPrecios(env) {
  const { results } = await env.DB.prepare(
    'SELECT producto_id, nombre, precio, peso_g, en_stock, url, actualizado FROM precios ORDER BY nombre',
  ).all();
  return {
    actualizado: results[0]?.actualizado ?? null,
    productos: results.map((r) => ({
      id: r.producto_id, nombre: r.nombre, precio: r.precio, pesoG: r.peso_g, enStock: Boolean(r.en_stock), url: r.url,
    })),
  };
}

function decodificarHtml(texto) {
  return texto
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Peso del rollo a partir del nombre: "1 kg", "0,25 kg", "500 g". */
function pesoEnGramos(nombre) {
  const m = nombre.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
  if (!m) return null;
  const valor = Number(m[1].replace(',', '.'));
  return Math.round(m[2].toLowerCase() === 'kg' ? valor * 1000 : valor);
}

function normalizar(producto) {
  const nombre = decodificarHtml(producto.name).replace(/\s+/g, ' ').trim();
  if (/^combo/i.test(nombre) || /2[.,]85/.test(nombre)) return null; // solo rollos sueltos de 1.75 mm
  const pesoG = pesoEnGramos(nombre);
  const precio = Number(producto.prices?.price) / 10 ** (producto.prices?.currency_minor_unit ?? 2);
  if (!pesoG || !precio) return null;
  return { id: producto.id, nombre, precio: Math.round(precio), pesoG, enStock: producto.is_in_stock, url: producto.permalink };
}

async function actualizarPrecios(env, { forzar = false } = {}) {
  if (!forzar) {
    const ultima = await env.DB.prepare('SELECT MAX(actualizado) AS a FROM precios').first();
    if (ultima?.a && Date.now() - Date.parse(ultima.a) < MINUTOS_ENTRE_ACTUALIZACIONES * 60_000) {
      return { ...(await listarPrecios(env)), cacheado: true };
    }
  }

  const resp = await fetch(PRINTALOT_API, {
    headers: { Accept: 'application/json', 'User-Agent': 'calculadora-3d-personal (consulta semanal de precios)' },
  });
  if (!resp.ok) throw new HttpError(502, `PrintALot respondió ${resp.status}`);
  const productos = (await resp.json()).map(normalizar).filter(Boolean);
  if (!productos.length) throw new HttpError(502, 'PrintALot no devolvió filamentos');

  const ahora = new Date().toISOString();
  const insertar = env.DB.prepare(
    'INSERT INTO precios (producto_id, nombre, precio, peso_g, en_stock, url, actualizado) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  );
  await env.DB.batch([
    env.DB.prepare('DELETE FROM precios'),
    ...productos.map((p) => insertar.bind(p.id, p.nombre, p.precio, p.pesoG, p.enStock ? 1 : 0, p.url, ahora)),
  ]);
  return listarPrecios(env);
}
