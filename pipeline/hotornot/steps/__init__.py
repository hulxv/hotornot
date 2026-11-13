"""Pipeline steps. `python -m hotornot` exposes every module in this package that defines all of:

    NAME                    subcommand, e.g. "static-mask" for static_mask.py
    HELP                    one line for `python -m hotornot --help`
    add_arguments(parser)   adds the step's options to its argparse subparser
    run(args)               does the work; an int return value becomes the exit status

Modules without them are helpers and are not listed. The CLI imports every module on each
call, so do no work at import time.
"""
