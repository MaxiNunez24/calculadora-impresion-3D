"""Genera las plaquitas de muestra de filamento (STL).

- Zona lisa de 2 mm para escribir el nombre del color (con la herramienta Texto de PrusaSlicer).
- Escalones de 1.6 / 1.2 / 0.8 / 0.4 mm para ver la transparencia y el brillo de cada filamento.
- Agujero para colgar todas las muestras de una argolla, como un llavero.

Variantes:
  muestrario.stl           50 × 30 mm, mucho lugar para el texto
  muestrario_compacto.stl  38 × 22 mm, agujero en la esquina, se imprime en la mitad de tiempo

Uso:  python generar_muestrario.py   (no necesita librerías externas)
"""
import math
import struct
from pathlib import Path

DIVISIONES = 12  # segmentos por lado del cuadrado del agujero (48 en total para el círculo)
DENSIDAD_PLA = 1.24  # g/cm³

# Medidas en mm. "escalones": (x desde, x hasta, altura), primero la zona lisa.
# "celda_agujero": x0, x1, y0, y1 del cuadrado que rodea al agujero (debe caer en la zona lisa).
VARIANTES = {
    'muestrario.stl': {
        'profundidad': 30.0,
        'escalones': [(0, 30, 2.0), (30, 35, 1.6), (35, 40, 1.2), (40, 45, 0.8), (45, 50, 0.4)],
        'agujero_centro': (6.0, 15.0),
        'agujero_radio': 2.5,
        'celda_agujero': (2.0, 10.0, 11.0, 19.0),
    },
    'muestrario_compacto.stl': {
        'profundidad': 22.0,
        'escalones': [(0, 20, 2.0), (20, 24.5, 1.6), (24.5, 29, 1.2), (29, 33.5, 0.8), (33.5, 38, 0.4)],
        'agujero_centro': (4.5, 17.5),
        'agujero_radio': 2.2,
        'celda_agujero': (1.5, 7.5, 14.5, 20.5),
    },
}


def P(x, y):
    return (round(x, 6), round(y, 6))


def ccw(t):
    (ax, ay), (bx, by), (cx, cy) = t
    return t if (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0 else (t[0], t[2], t[1])


def normal(a, b, c):
    ux, uy, uz = (b[i] - a[i] for i in range(3))
    vx, vy, vz = (c[i] - a[i] for i in range(3))
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    m = math.sqrt(sum(x * x for x in n)) or 1
    return tuple(x / m for x in n)


def generar(salida, profundidad, escalones, agujero_centro, agujero_radio, celda_agujero):
    def altura_en(x):
        for x0, x1, h in escalones:
            if x0 <= x < x1:
                return h
        raise ValueError(x)

    # ---------- Huella 2D: grilla de celdas rectangulares ----------
    cx0, cx1, cy0, cy1 = celda_agujero
    xs = sorted({x for x0, x1, _ in escalones for x in (x0, x1)} | {cx0, cx1})
    ys = sorted({0.0, cy0, cy1, profundidad})
    lados_agujero = {
        frozenset({P(cx0, cy0), P(cx1, cy0)}), frozenset({P(cx1, cy0), P(cx1, cy1)}),
        frozenset({P(cx1, cy1), P(cx0, cy1)}), frozenset({P(cx0, cy1), P(cx0, cy0)}),
    }

    def puntos_lado(a, b):
        """Puntos de a hacia b (sin incluir b). Los lados del cuadrado del agujero se subdividen
        igual desde ambas celdas vecinas para que la malla quede cerrada."""
        if frozenset({P(*a), P(*b)}) not in lados_agujero:
            return [P(*a)]
        return [P(a[0] + (b[0] - a[0]) * i / DIVISIONES, a[1] + (b[1] - a[1]) * i / DIVISIONES) for i in range(DIVISIONES)]

    def contorno(x0, x1, y0, y1):
        esquinas = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        pts = []
        for i in range(4):
            pts += puntos_lado(esquinas[i], esquinas[(i + 1) % 4])
        return pts

    triangulos_2d = []  # (triángulo, altura)
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
            h = altura_en((x0 + x1) / 2)
            borde = contorno(x0, x1, y0, y1)
            n = len(borde)
            if (x0, x1, y0, y1) == tuple(celda_agujero):
                # Anillo entre el cuadrado y el círculo, con puntos en los mismos ángulos
                ax, ay = agujero_centro
                circ = []
                for (sx, sy) in borde:
                    d = math.hypot(sx - ax, sy - ay)
                    circ.append(P(ax + agujero_radio * (sx - ax) / d, ay + agujero_radio * (sy - ay) / d))
                for k in range(n):
                    s0, s1, c0, c1 = borde[k], borde[(k + 1) % n], circ[k], circ[(k + 1) % n]
                    triangulos_2d += [(ccw((s0, s1, c1)), h), (ccw((s0, c1, c0)), h)]
            elif n == 4:
                triangulos_2d += [(ccw((borde[0], borde[1], borde[2])), h), (ccw((borde[0], borde[2], borde[3])), h)]
            else:
                c = P((x0 + x1) / 2, (y0 + y1) / 2)
                triangulos_2d += [(ccw((c, borde[k], borde[(k + 1) % n])), h) for k in range(n)]

    # ---------- Malla 3D ----------
    niveles_globales = sorted({0.0} | {h for *_, h in escalones})
    caras = []
    aristas = {}
    for t, h in triangulos_2d:
        a, b, c = t
        caras.append(((*a, h), (*b, h), (*c, h)))        # arriba
        caras.append(((*a, 0.0), (*c, 0.0), (*b, 0.0)))  # abajo
        for u, v in ((a, b), (b, c), (c, a)):
            aristas[(u, v)] = h

    # Paredes donde cambia la altura (bordes, escalones y agujero), cortadas en cada nivel
    for (u, v), h in aristas.items():
        h_vecino = aristas.get((v, u), 0.0)
        if h <= h_vecino:
            continue
        niveles = [z for z in niveles_globales if h_vecino <= z <= h]
        for z0, z1 in zip(niveles, niveles[1:]):
            caras.append(((*u, z0), (*v, z0), (*v, z1)))
            caras.append(((*u, z0), (*v, z1), (*u, z1)))

    # ---------- Verificación: malla cerrada (cada arista usada una vez en cada sentido) ----------
    dirigidas = {}
    for f in caras:
        for k in range(3):
            e = (f[k], f[(k + 1) % 3])
            dirigidas[e] = dirigidas.get(e, 0) + 1
    errores = sum(1 for (a, b), n in dirigidas.items() if n != 1 or dirigidas.get((b, a)) != 1)

    volumen = sum(
        (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
        for a, b, c in caras
    )

    with open(salida, 'wb') as f:
        f.write(b'Muestrario de filamento - calculadora 3D'.ljust(80, b' '))
        f.write(struct.pack('<I', len(caras)))
        for a, b, c in caras:
            f.write(struct.pack('<12fH', *normal(a, b, c), *a, *b, *c, 0))

    ancho = escalones[-1][1]
    print(f'{salida.name} ({ancho:g} × {profundidad:g} mm): {len(caras)} triángulos, '
          f'malla {"cerrada OK" if errores == 0 else f"con {errores} errores"}, '
          f'{volumen / 1000:.2f} cm³ ~ {volumen / 1000 * DENSIDAD_PLA:.1f} g de PLA')


if __name__ == '__main__':
    for nombre, parametros in VARIANTES.items():
        generar(Path(__file__).with_name(nombre), **parametros)
