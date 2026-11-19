from setuptools import setup, Extension
from Cython.Build import cythonize

setup(
    name='perf',
    ext_modules=cythonize(
        [Extension('perf', ['perf.pyx'])],
        compiler_directives={'boundscheck': False, 'wraparound': False, 'cdivision': True},
    ),
)
