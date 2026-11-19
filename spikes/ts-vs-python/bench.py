"""Python 侧同一份算法（x+=vx; y+=vy; s+=x），五种写法。

运行：
    pip install numpy cython
    python setup.py build_ext --inplace     # 需要 C 编译器
    python bench.py

计时纪律：所有"入参构造 / 缓冲区分配"都在计时之外完成，否则测到的是转换成本
而不是积分循环本身（第一版基准就犯了这个错，见 README 的"方法论修正"）。
"""
import time
import array
import platform

import numpy as np
import perf

N, TICKS = 100_000, 60
OPS = N * TICKS


def best_ns(fn, runs=7):
    fn()  # warmup
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t0)
    times.sort()
    return times[0] * 1e9 / OPS


base = ([float(i) for i in range(N)], [float(i) for i in range(N)], [1.0] * N, [2.0] * N)
arrs = tuple(array.array('d', a) for a in base)
nx, ny = np.array(base[0]), np.array(base[1])
nvx, nvy = np.array(base[2]), np.array(base[3])
raw = perf.RawWorld(N)


def py_list():
    x, y, vx, vy = base
    s = 0.0
    for _ in range(TICKS):
        for i in range(N):
            x[i] += vx[i]; y[i] += vy[i]; s += x[i]
    return s


def py_array():
    x, y, vx, vy = arrs
    s = 0.0
    for _ in range(TICKS):
        for i in range(N):
            x[i] += vx[i]; y[i] += vy[i]; s += x[i]
    return s


def numpy_vec():
    x, y = nx.copy(), ny.copy()  # 与 Cython 版对等：副本在循环外建好
    s = 0.0
    for _ in range(TICKS):
        x += nvx; y += nvy; s += float(x.sum())
    return s


def cython_memview():
    x, y = nx.copy(), ny.copy()
    return perf.integrate_memview(x, y, nvx, nvy, TICKS)


def cython_rawptr():
    return raw.integrate(TICKS)


print(f"Python {platform.python_version()}  numpy {np.__version__}  N={N} ticks={TICKS}")
print(f"{'实现':<40}{'ns/实体·tick':>14}")
for name, fn in [
    ('纯 Python（list）', py_list),
    ('Python + array("d")', py_array),
    ('Python + numpy 向量化', numpy_vec),
    ('Cython memoryview（double[::1]）', cython_memview),
    ('Cython 裸指针（cdef class + malloc）', cython_rawptr),
]:
    print(f"{name:<40}{best_ns(fn):>14.2f}")
