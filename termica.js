'use strict';
// Impresora térmica: venta rápida para la expo, papel restante, recupero de la inversión.
// Usa lo definido en app.js: $, money, dec, api, conectado, config, saveConfig, renderTabla, leerJson, escribirJson.

const MOVIMIENTOS_KEY = 'calc3d.movimientos.v1';

// Movimientos de este dispositivo. "pendiente": falta subirlo al Worker; "borrado": falta borrarlo allá.
let movimientos = leerJson(MOVIMIENTOS_KEY, []);
const guardarMovimientos = () => escribirJson(MOVIMIENTOS_KEY, movimientos);
const activos = () => movimientos.filter((m) => !m.borrado);
const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const esHoy = (iso) => new Date(iso).toDateString() === new Date().toDateString();
const sumar = (lista, f) => lista.reduce((s, x) => s + f(x), 0);

// ---------- Cálculos ----------
const term = () => config.termica;
const papel = (id) => term().papeles.find((p) => p.id === id) || term().papeles[0];
const precioCm = (p) => (p && p.largoRolloCm > 0 ? p.precioRollo / p.largoRolloCm : 0);
const amortizacionPorImpresion = () => (term().vidaUtilImpresiones > 0 ? term().valorImpresora / term().vidaUtilImpresiones : 0);

function costoProducto(prod) {
  const cm = prod.impresiones * prod.largoCm;
  const costoPapel = cm * precioCm(papel(prod.papelId));
  const amortizacion = prod.impresiones * amortizacionPorImpresion();
  return { cm, costoPapel, amortizacion, ganancia: prod.precio - costoPapel - amortizacion };
}

/** Papel usado del rollo actual y rollos de repuesto, a partir de los movimientos. */
function estadoPapel(p) {
  const movs = activos().filter((m) => m.papelId === p.id).sort((a, b) => a.fecha.localeCompare(b.fecha));
  let usado = 0;
  let stock = 0;
  let compras = false;
  for (const m of movs) {
    if (m.tipo === 'cambio_rollo') { usado = 0; stock -= 1; }
    if (m.tipo === 'compra_rollos') { stock += m.cantidad; compras = true; }
    if (m.tipo === 'venta') usado += m.cm;
  }
  // Largo típico de una impresión con este papel, para estimar cuántas entran
  const largoTipico = term().productos.find((x) => x.papelId === p.id)?.largoCm || 10;
  const restante = Math.max(0, p.largoRolloCm - usado);
  return { usado, restante, stock: compras ? stock : null, quedan: Math.floor(restante / largoTipico) };
}

function resumen(movs) {
  const ventas = movs.filter((m) => m.tipo === 'venta');
  const cobradas = ventas.filter((m) => !m.esPrueba);
  const total = sumar(cobradas, (m) => m.precio);
  const costoPapel = sumar(ventas, (m) => m.costoPapel); // las pruebas también gastan papel
  return {
    ventas: cobradas.length,
    impresiones: sumar(cobradas, (m) => m.impresiones),
    pruebas: sumar(ventas.filter((m) => m.esPrueba), (m) => m.impresiones),
    efectivo: sumar(cobradas.filter((m) => m.metodo === 'efectivo'), (m) => m.precio),
    transferencia: sumar(cobradas.filter((m) => m.metodo === 'transferencia'), (m) => m.precio),
    total,
    costoPapel,
    ganancia: total - costoPapel, // sin amortización: es lo que va recuperando la impresora
  };
}

// ---------- Registrar ----------
function registrar(movimiento) {
  movimientos.push({ id: nuevoId(), fecha: new Date().toISOString(), ...movimiento, pendiente: true });
  guardarMovimientos();
  renderTermica();
  sincronizarTermica();
  return movimientos[movimientos.length - 1];
}

function borrarMovimiento(id) {
  const m = movimientos.find((x) => x.id === id);
  if (!m) return;
  if (m.pendiente) movimientos = movimientos.filter((x) => x.id !== id); // nunca llegó a la nube
  else m.borrado = true;
  guardarMovimientos();
  renderTermica();
  sincronizarTermica();
}

function vender(prod) {
  const metodo = document.querySelector('input[name="metodoPago"]:checked')?.value || 'efectivo';
  const c = costoProducto(prod);
  const m = registrar({
    tipo: 'venta', productoId: prod.id, nombre: prod.nombre, impresiones: prod.impresiones, precio: prod.precio,
    metodo, papelId: prod.papelId, cm: c.cm, costoPapel: Math.round(c.costoPapel), amortizacion: Math.round(c.amortizacion),
  });
  mostrarToast(`✓ ${prod.nombre} · ${money.format(prod.precio)} (${metodo})`, m.id);
}

function prueba(p) {
  const largo = term().productos.find((x) => x.papelId === p.id)?.largoCm || 10;
  const m = registrar({
    tipo: 'venta', esPrueba: true, nombre: 'Prueba / regalo', impresiones: 1, precio: 0, metodo: null,
    papelId: p.id, cm: largo, costoPapel: Math.round(largo * precioCm(p)), amortizacion: Math.round(amortizacionPorImpresion()),
  });
  mostrarToast(`✓ Prueba en ${p.nombre}`, m.id);
}

let timerToast;
function mostrarToast(texto, id) {
  const toast = $('#toastVenta');
  $('#toastTexto').textContent = texto;
  toast.dataset.id = id;
  toast.hidden = false;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => { toast.hidden = true; }, 8000);
}

// ---------- Sincronización (funciona sin internet: lo pendiente se sube después) ----------
let sincronizando = false;
async function sincronizarTermica() {
  if (!conectado() || sincronizando) return;
  sincronizando = true;
  let ok = false;
  try {
    for (const m of movimientos.filter((x) => x.pendiente || x.borrado)) {
      if (m.borrado) {
        await api('DELETE', `/movimientos/${encodeURIComponent(m.id)}`);
        m.subido = true;
      } else {
        const { pendiente, ...datos } = m;
        await api('PUT', `/movimientos/${encodeURIComponent(m.id)}`, datos);
        m.pendiente = false;
      }
    }
    movimientos = movimientos.filter((x) => !(x.borrado && x.subido));
    // La nube manda; se conservan los locales que todavía no se pudieron subir
    const remotos = await api('GET', '/movimientos');
    const locales = movimientos.filter((x) => x.pendiente || x.borrado);
    const idsLocales = new Set(locales.map((x) => x.id));
    movimientos = [...remotos.filter((r) => !idsLocales.has(r.id)), ...locales];
    guardarMovimientos();
    ok = true;
  } catch { /* sin conexión: queda pendiente y se reintenta */ } finally {
    sincronizando = false;
    renderTermica();
  }
  // Si se registró algo mientras se sincronizaba, se sube ahora
  if (ok && movimientos.some((x) => x.pendiente || x.borrado)) sincronizarTermica();
}

// ---------- Pantalla ----------
function stat(etiqueta, valor, detalle = '') {
  const div = document.createElement('div');
  div.className = 'stat';
  div.innerHTML = '<span></span><strong></strong><small></small>';
  div.querySelector('span').textContent = etiqueta;
  div.querySelector('strong').textContent = valor;
  div.querySelector('small').textContent = detalle;
  return div;
}

function renderBotones() {
  $('#botonesVenta').replaceChildren(...term().productos.map((prod) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-venta';
    b.innerHTML = '<span></span><strong></strong>';
    b.querySelector('span').textContent = prod.nombre;
    b.querySelector('strong').textContent = money.format(prod.precio);
    b.addEventListener('click', () => vender(prod));
    return b;
  }));
  $('#botonesPrueba').replaceChildren(...term().papeles.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small secondary';
    b.textContent = `Prueba / regalo en ${p.nombre}`;
    b.title = 'Gasta papel pero no cobra';
    b.addEventListener('click', () => prueba(p));
    return b;
  }));
}

function renderResumenHoy() {
  const r = resumen(activos().filter((m) => esHoy(m.fecha)));
  $('#resumenHoy').replaceChildren(
    stat('Ventas', r.ventas, r.pruebas ? `+ ${r.pruebas} de prueba` : ''),
    stat('Impresiones', r.impresiones),
    stat('Caja', money.format(r.total), `💵 ${money.format(r.efectivo)} · 📲 ${money.format(r.transferencia)}`),
    stat('Ganancia', money.format(r.ganancia), `papel usado: ${money.format(r.costoPapel)}`),
  );
}

function renderPapel() {
  $('#estadoPapel').replaceChildren(...term().papeles.map((p) => {
    const e = estadoPapel(p);
    const pct = p.largoRolloCm > 0 ? (e.restante / p.largoRolloCm) * 100 : 0;
    const div = document.createElement('div');
    div.className = `papel-estado${e.quedan <= 2 ? ' poco' : ''}`;
    div.innerHTML = `
      <div class="linea"><strong></strong><span></span></div>
      <div class="barra"><span style="width:${pct.toFixed(1)}%"></span></div>
      <small></small>
      <div class="acciones">
        <button type="button" class="btn small secondary" data-accion="cambio">Cambié de rollo</button>
        <button type="button" class="btn small secondary" data-accion="compra">+ Compré rollos</button>
      </div>`;
    div.querySelector('.linea strong').textContent = p.nombre;
    div.querySelector('.linea span').textContent = `${dec(e.restante)} de ${p.largoRolloCm} cm`;
    div.querySelector('small').textContent =
      `≈ ${e.quedan} impresiones más en este rollo · Repuestos: ${e.stock == null ? 'cargá tu compra' : e.stock}`;
    div.querySelector('[data-accion="cambio"]').addEventListener('click', () => {
      if (confirm(`¿Pusiste un rollo nuevo de ${p.nombre}?`)) registrar({ tipo: 'cambio_rollo', papelId: p.id });
    });
    div.querySelector('[data-accion="compra"]').addEventListener('click', () => {
      const cantidad = Math.round(Number(prompt(`¿Cuántos rollos de ${p.nombre} compraste?`, '5')));
      if (cantidad > 0) registrar({ tipo: 'compra_rollos', papelId: p.id, cantidad, costo: cantidad * p.precioRollo });
    });
    return div;
  }));
}

function renderRecupero() {
  const r = resumen(activos());
  const valor = term().valorImpresora;
  const pct = valor > 0 ? Math.min(100, (r.ganancia / valor) * 100) : 0;
  const falta = Math.max(0, valor - r.ganancia);
  // Ganancia promedio por impresión: la real si ya hay ventas; si no, la del primer producto
  const primero = term().productos[0];
  const promedio = r.impresiones > 0
    ? r.ganancia / r.impresiones
    : primero ? (primero.precio - costoProducto(primero).costoPapel) / primero.impresiones : 0;
  const cont = $('#recupero');
  cont.innerHTML = `
    <div class="linea"><strong></strong><span></span></div>
    <div class="barra progreso"><span style="width:${pct.toFixed(1)}%"></span></div>
    <p class="nota"></p>`;
  cont.querySelector('.linea strong').textContent = `${money.format(r.ganancia)} de ${money.format(valor)}`;
  cont.querySelector('.linea span').textContent = `${pct.toFixed(0)}%`;
  cont.querySelector('.nota').textContent = falta === 0
    ? '🎉 ¡La impresora ya está recuperada!'
    : `Faltan ${money.format(falta)}: ≈ ${promedio > 0 ? Math.ceil(falta / promedio) : '—'} impresiones más, ` +
      `a ${money.format(promedio)} de ganancia promedio cada una. ` +
      `Llevás ${r.impresiones} impresiones vendidas en total.`;
}

function renderCostos() {
  const filas = term().productos.map((prod) => {
    const c = costoProducto(prod);
    return `<tr><td></td><td>${money.format(prod.precio)}</td><td>${money.format(c.costoPapel)}</td>` +
      `<td>${money.format(c.amortizacion)}</td><td class="${c.ganancia >= 0 ? 'positivo' : 'negativo'}">${money.format(c.ganancia)}</td></tr>`;
  });
  const tabla = $('#costosTermica');
  tabla.innerHTML = `<thead><tr><th>Producto</th><th>Precio</th><th>Papel</th><th>Amortiz.</th><th>Ganancia</th></tr></thead><tbody>${filas.join('')}</tbody>`;
  tabla.querySelectorAll('tbody tr').forEach((tr, i) => { tr.cells[0].textContent = term().productos[i].nombre; });
  $('#notaCostosTermica').textContent =
    `Papel: ${money.format(precioCm(term().papeles[0]) * 10)} cada 10 cm. Amortización: ${money.format(term().valorImpresora)} ÷ ` +
    `${term().vidaUtilImpresiones} impresiones = ${money.format(amortizacionPorImpresion())} por impresión. ` +
    'El recupero cuenta la ganancia sin amortización, porque esa es justamente la parte que paga la impresora.';
}

function describir(m) {
  const p = papel(m.papelId)?.nombre || '';
  if (m.tipo === 'cambio_rollo') return `🔄 Rollo nuevo de ${p}`;
  if (m.tipo === 'compra_rollos') return `🛒 Compra de ${m.cantidad} rollos de ${p} · ${money.format(m.costo)}`;
  if (m.esPrueba) return `🧪 Prueba / regalo · ${p}`;
  return `${m.metodo === 'transferencia' ? '📲' : '💵'} ${m.nombre} · ${money.format(m.precio)}`;
}

function renderMovimientos() {
  const lista = activos().sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 60);
  const ul = $('#listaMovimientos');
  if (!lista.length) {
    ul.innerHTML = '<li class="vacio">Todavía no hay movimientos.</li>';
  } else {
    ul.replaceChildren(...lista.map((m) => {
      const li = document.createElement('li');
      li.innerHTML = '<div class="info"><strong></strong><small></small></div><button class="icon-btn" title="Borrar">✕</button>';
      li.querySelector('strong').textContent = describir(m);
      li.querySelector('small').textContent =
        new Date(m.fecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) + (m.pendiente ? ' · ⏳ sin subir' : '');
      li.querySelector('button').addEventListener('click', () => {
        if (confirm(`¿Borrar "${describir(m)}"?`)) borrarMovimiento(m.id);
      });
      return li;
    }));
  }
  const pendientes = movimientos.filter((x) => x.pendiente || x.borrado).length;
  $('#tPendientes').textContent = pendientes ? `⏳ ${pendientes} sin subir` : '';
}

function renderConfigTermica() {
  document.querySelectorAll('[data-termica]').forEach((input) => { input.value = term()[input.dataset.termica]; });
  const alCambiar = (estructural) => {
    saveConfig();
    if (estructural) renderConfigTermica();
    renderTermica();
  };
  renderTabla($('#papelesBody'), term().papeles, [
    { clave: 'nombre', tipo: 'text' },
    { clave: 'precioRollo', tipo: 'number' },
    { clave: 'largoRolloCm', tipo: 'number' },
  ], { minimo: 1, onCambio: alCambiar });
  renderTabla($('#productosBody'), term().productos, [
    { clave: 'nombre', tipo: 'text' },
    { clave: 'impresiones', tipo: 'number' },
    { clave: 'precio', tipo: 'number' },
    { clave: 'largoCm', tipo: 'number' },
    { clave: 'papelId', tipo: 'select', texto: true, opciones: () => term().papeles.map((p) => [p.id, p.nombre]) },
  ], { minimo: 1, onCambio: alCambiar });
}

/** completo: también vuelve a dibujar las tablas de Ajustes (al cargar o al llegar la config de la nube). */
function renderTermica(completo = false) {
  if (completo) renderConfigTermica();
  renderBotones();
  renderResumenHoy();
  renderPapel();
  renderRecupero();
  renderCostos();
  renderMovimientos();
}

function exportarMovimientos() {
  const celda = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const tipos = { venta: 'Venta', cambio_rollo: 'Cambio de rollo', compra_rollos: 'Compra de rollos' };
  const filas = [
    ['Fecha', 'Hora', 'Tipo', 'Detalle', 'Impresiones', 'Cobrado', 'Pago', 'Papel', 'Cm de papel', 'Costo papel', 'Amortización'],
    ...activos().sort((a, b) => a.fecha.localeCompare(b.fecha)).map((m) => {
      const f = new Date(m.fecha);
      return [
        f.toLocaleDateString('es-AR'), f.toLocaleTimeString('es-AR', { timeStyle: 'short' }),
        m.esPrueba ? 'Prueba' : tipos[m.tipo], m.nombre || (m.cantidad ? `${m.cantidad} rollos` : ''),
        m.impresiones ?? '', m.precio ?? m.costo ?? '', m.metodo ?? '', papel(m.papelId)?.nombre ?? '',
        m.cm ?? '', m.costoPapel ?? '', m.amortizacion ?? '',
      ];
    }),
  ];
  const csv = '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `termica-movimientos-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- Eventos ----------
document.querySelectorAll('[data-termica]').forEach((input) => {
  input.addEventListener('input', () => {
    term()[input.dataset.termica] = num(input.value);
    saveConfig();
    renderTermica();
  });
});
$('#agregarPapel').addEventListener('click', () => {
  term().papeles.push({ id: `p${Date.now()}`, nombre: 'Nuevo papel', precioRollo: 1000, largoRolloCm: 300 });
  saveConfig();
  renderTermica(true);
});
$('#agregarProducto').addEventListener('click', () => {
  term().productos.push({ id: `t${Date.now()}`, nombre: 'Nuevo producto', impresiones: 1, precio: 100, largoCm: 10, papelId: term().papeles[0].id });
  saveConfig();
  renderTermica(true);
});
$('#deshacerVenta').addEventListener('click', () => {
  const toast = $('#toastVenta');
  borrarMovimiento(toast.dataset.id);
  toast.hidden = true;
});
$('#exportarMovimientos').addEventListener('click', exportarMovimientos);
window.addEventListener('online', sincronizarTermica);
setInterval(() => { if (movimientos.some((x) => x.pendiente || x.borrado)) sincronizarTermica(); }, 60_000);

renderTermica(true);
if (conectado()) sincronizarTermica();
