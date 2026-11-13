"""`hotornot <step>`: one subcommand for each step module in hotornot/steps/."""
import argparse
import importlib
import pkgutil
import sys

STEP_ATTRS = ("NAME", "HELP", "add_arguments", "run")


def discover_steps(package="hotornot.steps"):
    """{NAME: module} for every module in `package` that defines all of STEP_ATTRS."""
    pkg = importlib.import_module(package)
    steps = {}
    for info in pkgutil.iter_modules(pkg.__path__):
        if info.name.startswith("_"):
            continue
        module_name = f"{package}.{info.name}"
        try:
            module = importlib.import_module(module_name)
        except Exception as e:
            # A broken step must not take every other step down with it.
            print(f"hotornot: skipping {module_name}: {type(e).__name__}: {e}", file=sys.stderr)
            continue
        if not all(hasattr(module, attr) for attr in STEP_ATTRS):
            continue
        if module.NAME in steps:
            raise RuntimeError(f"step {module.NAME!r} is defined by both "
                               f"{steps[module.NAME].__name__} and {module_name}")
        steps[module.NAME] = module
    return dict(sorted(steps.items()))


def build_parser(steps):
    parser = argparse.ArgumentParser(
        prog="hotornot",
        description="HotOrNot pipeline. The database is $HOTORNOT_DB "
                    "(default pipeline/data/hotornot.sqlite).")
    sub = parser.add_subparsers(dest="step", metavar="STEP", required=True)
    for name, module in steps.items():
        step_parser = sub.add_parser(name, help=module.HELP, description=module.HELP)
        module.add_arguments(step_parser)
        step_parser.set_defaults(_step=module)
    return parser


def main(argv=None, package="hotornot.steps"):
    args = build_parser(discover_steps(package)).parse_args(argv)
    return args._step.run(args)


if __name__ == "__main__":
    sys.exit(main())
