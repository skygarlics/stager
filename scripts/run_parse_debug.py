#!/usr/bin/env python3
import runpy
import traceback

if __name__ == '__main__':
    try:
        runpy.run_path('d:/coding/stager/scripts/parse_drumtower.py', run_name='__main__')
    except Exception:
        traceback.print_exc()
        raise
