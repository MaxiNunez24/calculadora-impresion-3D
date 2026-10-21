-- Configuración compartida (una sola fila)
CREATE TABLE IF NOT EXISTS config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  datos       TEXT NOT NULL,          -- JSON
  actualizado TEXT NOT NULL           -- ISO 8601, gana el más reciente
);

-- Historial de evaluaciones de costo
CREATE TABLE IF NOT EXISTS evaluaciones (
  id    TEXT PRIMARY KEY,
  fecha TEXT NOT NULL,
  datos TEXT NOT NULL                 -- JSON completo de la evaluación
);
CREATE INDEX IF NOT EXISTS idx_evaluaciones_fecha ON evaluaciones (fecha);

-- Últimos precios leídos de PrintALot
CREATE TABLE IF NOT EXISTS precios (
  producto_id INTEGER PRIMARY KEY,
  nombre      TEXT NOT NULL,
  precio      INTEGER NOT NULL,       -- pesos argentinos
  peso_g      INTEGER NOT NULL,
  en_stock    INTEGER NOT NULL,
  url         TEXT,
  actualizado TEXT NOT NULL
);
