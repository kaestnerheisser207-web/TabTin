#!/usr/bin/env python3
"""Fail closed on production target drift; optionally resolve approved existing images."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys

TARGET = {"DEPLOY_TARGET": "sg01", "DEPLOY_HOST": "15.235.211.82", "DEPLOY_PORT": "22", "DEPLOY_USER": "tabtin-deploy"}
REPOSITORIES = {
    "django_digest": "ghcr.io/kaestnerheisser207-web/muse-community-django",
    "web_digest": "ghcr.io/kaestnerheisser207-web/muse-web",
    "collab_digest": "ghcr.io/kaestnerheisser207-web/muse-collab-live",
}
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def validate_target(environment):
    for key, expected in TARGET.items():
        actual = environment.get(key, "")
        if actual != expected:
            raise ValueError(f"Production target sg01 mismatch: {key} must be {expected}, received {json.dumps(actual)}")


def validate_inputs(environment):
    validate_target(environment)
    deployment = environment.get("DEPLOYMENT_KIND", "")
    if deployment not in ("standard", "cloud"):
        raise ValueError("deployment must be standard or cloud")
    reuse = environment.get("REUSE_IMAGES", "false")
    if reuse not in ("true", "false"):
        raise ValueError("reuse_images must be a boolean")
    if reuse == "true" and deployment != "standard":
        raise ValueError("reuse_images is supported only for explicit standard deployment")
    for key in ("RELEASE_SHA", "WORKFLOW_REVISION"):
        if not SHA.fullmatch(environment.get(key, "")):
            raise ValueError(f"{key} must be a full lowercase commit SHA")
    if environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and environment.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("Production workflow_dispatch must use refs/heads/main")


def _run(command):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
    if result.returncode:
        # Never print registry/SSH process output that may include credentials.
        raise ValueError(f"Command failed: {' '.join(command[:3])} (exit {result.returncode})")
    return result.stdout


def validate_main_ancestry(environment, run=_run):
    validate_inputs(environment)
    for key in ("WORKFLOW_REVISION", "RELEASE_SHA"):
        run(["git", "merge-base", "--is-ancestor", environment[key], "refs/remotes/origin/main"])


def resolve_existing_images(release_sha, run=_run):
    if not SHA.fullmatch(release_sha):
        raise ValueError("Image release must be a full lowercase main SHA")
    resolved = {}
    for output, repository in REPOSITORIES.items():
        reference = f"{repository}:sha-{release_sha}"
        run(["docker", "pull", "--platform", "linux/amd64", reference])
        image = json.loads(run(["docker", "image", "inspect", "--format", "{{json .}}", reference]))
        if image.get("Os") != "linux" or image.get("Architecture") != "amd64":
            raise ValueError(f"Existing {repository} image must be linux/amd64")
        config = image.get("Config") or {}
        labels = config.get("Labels") or {}
        revision = labels.get("org.opencontainers.image.revision")
        if revision != release_sha:
            raise ValueError(f"Existing {repository} image revision does not match requested release")
        candidates = set()
        for value in image.get("RepoDigests", []):
            if isinstance(value, str) and value.startswith(repository + "@"):
                digest = value[len(repository) + 1:]
                if DIGEST.fullmatch(digest):
                    candidates.add(digest)
        if len(candidates) != 1:
            raise ValueError(f"Existing {repository} image has no unambiguous approved digest")
        resolved[output] = candidates.pop()
    return resolved


def select_standard_digests(environment):
    validate_inputs(environment)
    if environment["DEPLOYMENT_KIND"] != "standard":
        raise ValueError("Standard image selection requires deployment=standard")
    prefix = "REUSED" if environment.get("REUSE_IMAGES") == "true" else "BUILT"
    outputs = {}
    for key in REPOSITORIES:
        value = environment.get(f"{prefix}_{key.upper()}", "")
        if not DIGEST.fullmatch(value):
            raise ValueError(f"Missing or invalid {prefix.lower()} {key}; no fallback is permitted")
        outputs[key] = value
    return outputs


def write_outputs(values, environment):
    output = environment.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a", encoding="utf-8") as handle:
            for key, value in values.items():
                handle.write(f"{key}={value}\n")
    print(json.dumps(values, sort_keys=True))


def main(argv=None, environment=None):
    argv = sys.argv[1:] if argv is None else argv
    environment = os.environ if environment is None else environment
    try:
        if argv == ["validate"]:
            validate_main_ancestry(environment)
            print(f"Validated production sg01; deployment={environment['DEPLOYMENT_KIND']}; application={environment['RELEASE_SHA']}; workflow={environment['WORKFLOW_REVISION']}")
        elif argv == ["reuse-standard"]:
            validate_main_ancestry(environment)
            if environment.get("REUSE_IMAGES") != "true":
                raise ValueError("reuse-standard requires explicit reuse_images=true")
            write_outputs(resolve_existing_images(environment["RELEASE_SHA"]), environment)
        elif argv == ["select-standard"]:
            validate_inputs(environment)
            write_outputs(select_standard_digests(environment), environment)
        else:
            raise ValueError("Expected validate, reuse-standard or select-standard")
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"VPS deployment rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
