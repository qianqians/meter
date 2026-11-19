# cython: boundscheck=False, wraparound=False, cdivision=True, initializedcheck=False, nonecheck=False
#
# 三种 Cython 写法，差别全在"热循环里还剩多少 Python/Cython 语义"：
#   1. integrate_memview : double[::1]（有 stride 与边界语义，索引仍走 C，但代码生成保守）
#   2. RawWorld.integrate: 裸指针（热循环里没有任何 PyObject，也没有 stride 语义）
# 注意：缓冲区分配必须放在计时之外，否则测到的是 malloc 而不是积分循环。

def integrate_memview(double[::1] x, double[::1] y, double[::1] vx, double[::1] vy, int ticks):
    cdef Py_ssize_t i, t, n = x.shape[0]
    cdef double s = 0.0
    for t in range(ticks):
        for i in range(n):
            x[i] += vx[i]
            y[i] += vy[i]
            s += x[i]
    return s


from libc.stdlib cimport malloc, free


cdef class RawWorld:
    """数据在 C 堆上，分配与初始化只做一次；integrate() 的热循环里没有 PyObject。"""
    cdef double* x
    cdef double* y
    cdef double* vx
    cdef double* vy
    cdef Py_ssize_t n

    def __cinit__(self, Py_ssize_t n):
        cdef Py_ssize_t i
        self.n = n
        self.x = <double*>malloc(n * sizeof(double))
        self.y = <double*>malloc(n * sizeof(double))
        self.vx = <double*>malloc(n * sizeof(double))
        self.vy = <double*>malloc(n * sizeof(double))
        if self.x == NULL or self.y == NULL or self.vx == NULL or self.vy == NULL:
            raise MemoryError()
        for i in range(n):
            self.x[i] = <double>i
            self.y[i] = <double>i
            self.vx[i] = 1.0
            self.vy[i] = 2.0

    def __dealloc__(self):
        if self.x != NULL: free(self.x)
        if self.y != NULL: free(self.y)
        if self.vx != NULL: free(self.vx)
        if self.vy != NULL: free(self.vy)

    def integrate(self, int ticks):
        cdef Py_ssize_t i, t, n = self.n
        cdef double s = 0.0
        cdef double* x = self.x
        cdef double* y = self.y
        cdef double* vx = self.vx
        cdef double* vy = self.vy
        for t in range(ticks):
            for i in range(n):
                x[i] += vx[i]
                y[i] += vy[i]
                s += x[i]
        return s
