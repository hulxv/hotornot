"""Pipeline steps. `hotornot.cli` exposes every module in this package that defines all of:

    NAME                    subcommand, e.g. "static-mask" for static_mask.py
    HELP                    one line for `hotornot --help`
    add_arguments(parser)   adds the step's options to its argparse subparser
    run(args)               does the work; an int return value becomes the exit status

Modules without them are helpers and are not listed. The CLI imports every module on each
call, so keep heavy imports (scikit-learn, shapely) inside `run`.
"""
