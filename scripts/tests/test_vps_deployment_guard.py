import importlib.util
import json
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("vps_deployment_guard", ROOT / "scripts/deploy/vps-deployment-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
RELEASE = "a" * 40
WORKFLOW = "b" * 40


def environment(**overrides):
    return {**guard.TARGET, "DEPLOYMENT_KIND": "standard", "REUSE_IMAGES": "false",
            "RELEASE_SHA": RELEASE, "WORKFLOW_REVISION": WORKFLOW,
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main", **overrides}


@pytest.mark.parametrize("field,value", [
    ("DEPLOY_TARGET", "ks6"), ("DEPLOY_TARGET", ""), ("DEPLOY_HOST", "ks6.example.com"),
    ("DEPLOY_HOST", ""), ("DEPLOY_HOST", "15.235.211.82\nanything"),
    ("DEPLOY_USER", "root"), ("DEPLOY_USER", ""), ("DEPLOY_PORT", "2222"), ("DEPLOY_PORT", "22;id"),
])
def test_wrong_production_target_is_rejected_before_any_external_command(field, value):
    commands = []
    with pytest.raises(ValueError, match="target sg01 mismatch"):
        guard.validate_main_ancestry(environment(**{field: value}), lambda command: commands.append(command))
    assert commands == []


@pytest.mark.parametrize("changes", [
    {"RELEASE_SHA": "main"}, {"RELEASE_SHA": "abc1234"}, {"RELEASE_SHA": "a" * 39 + "A"},
    {"RELEASE_SHA": RELEASE + "\n"}, {"WORKFLOW_REVISION": "feature"},
    {"GITHUB_REF": "refs/heads/release/unreviewed"}, {"DEPLOYMENT_KIND": ""},
    {"DEPLOYMENT_KIND": "all"}, {"REUSE_IMAGES": "yes"}, {"REUSE_IMAGES": "true", "DEPLOYMENT_KIND": "cloud"},
])
def test_malformed_or_unreviewed_dispatch_fails_closed(changes):
    with pytest.raises(ValueError):
        guard.validate_inputs(environment(**changes))


def test_application_and_workflow_commits_are_independently_checked_on_main():
    calls = []
    guard.validate_main_ancestry(environment(), lambda command: calls.append(command))
    assert calls == [["git", "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"] for sha in [WORKFLOW, RELEASE]]


def test_non_main_commit_rejection_stops_image_or_ssh_work():
    calls = []
    def run(command):
        calls.append(command)
        if RELEASE in command:
            raise ValueError("commit not in main")
    with pytest.raises(ValueError, match="not in main"):
        guard.validate_main_ancestry(environment(), run)
    assert all(command[0] == "git" for command in calls)


def image(reference, revision=RELEASE, architecture="amd64", os="linux"):
    repository = reference.split(":sha-", 1)[0]
    return {"Architecture": architecture, "Os": os, "Config": {"Labels": {"org.opencontainers.image.revision": revision}},
            "RepoDigests": [repository + "@sha256:" + "c" * 64]}


def test_reuse_resolves_only_three_approved_repositories_without_build_or_fallback():
    calls = []
    def run(command):
        calls.append(command)
        return json.dumps(image(command[-1])) if command[1] == "image" else ""
    result = guard.resolve_existing_images(RELEASE, run)
    assert result == {key: "sha256:" + "c" * 64 for key in guard.REPOSITORIES}
    assert len(calls) == 6
    assert all(command[:2] in (["docker", "pull"], ["docker", "image"]) for command in calls)
    assert [command[-1] for command in calls[::2]] == [f"{repo}:sha-{RELEASE}" for repo in guard.REPOSITORIES.values()]
    assert all(command[2:4] == ["--platform", "linux/amd64"] for command in calls[::2])


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(Architecture="arm64"),
    lambda value: value.update(Os="windows"),
    lambda value: value["Config"]["Labels"].update({"org.opencontainers.image.revision": WORKFLOW}),
    lambda value: value["Config"].update(Labels=None),
    lambda value: value.update(RepoDigests=[]),
    lambda value: value.update(RepoDigests=["ghcr.io/other/repo@sha256:" + "c" * 64]),
    lambda value: value.update(RepoDigests=["ghcr.io/kaestnerheisser207-web/muse-community-django:latest@sha256:" + "c" * 64]),
    lambda value: value.update(RepoDigests=["ghcr.io/kaestnerheisser207-web/muse-community-django@sha256:short"]),
])
def test_reuse_rejects_invalid_image_identity(mutation):
    def run(command):
        value = image(command[-1]); mutation(value)
        return json.dumps(value) if command[1] == "image" else ""
    with pytest.raises(ValueError):
        guard.resolve_existing_images(RELEASE, run)


def test_missing_image_does_not_fall_back_to_build_or_another_tag():
    calls = []
    def run(command):
        calls.append(command)
        raise ValueError("image missing")
    with pytest.raises(ValueError, match="image missing"):
        guard.resolve_existing_images(RELEASE, run)
    assert len(calls) == 1 and calls[0][:2] == ["docker", "pull"]


def test_reuse_digest_selection_never_falls_back_to_available_build_outputs():
    built = {f"BUILT_{key.upper()}": "sha256:" + "d" * 64 for key in guard.REPOSITORIES}
    with pytest.raises(ValueError, match="no fallback"):
        guard.select_standard_digests(environment(REUSE_IMAGES="true", **built))
    reused = {f"REUSED_{key.upper()}": "sha256:" + "c" * 64 for key in guard.REPOSITORIES}
    assert set(guard.select_standard_digests(environment(REUSE_IMAGES="true", **built, **reused)).values()) == {"sha256:" + "c" * 64}
    assert set(guard.select_standard_digests(environment(**built, **reused)).values()) == {"sha256:" + "d" * 64}


def test_outputs_are_written_only_after_all_images_validate(tmp_path, monkeypatch):
    output = tmp_path / "outputs"
    monkeypatch.setattr(guard, "validate_main_ancestry", lambda environment: None)
    monkeypatch.setattr(guard, "resolve_existing_images", lambda sha: (_ for _ in ()).throw(ValueError("third image mismatch")))
    assert guard.main(["reuse-standard"], environment(REUSE_IMAGES="true", GITHUB_OUTPUT=str(output))) == 1
    assert not output.exists()


def test_main_ancestry_uses_real_git_graph_and_allows_an_older_main_release(tmp_path):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(tmp_path), *args], text=True).strip()
    git("init", "-b", "main")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("commit", "--allow-empty", "-m", "first")
    first = git("rev-parse", "HEAD")
    git("commit", "--allow-empty", "-m", "workflow")
    second = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", second)
    def run(command):
        result = subprocess.run([command[0], "-C", str(tmp_path), *command[1:]], capture_output=True, text=True)
        if result.returncode:
            raise ValueError("not a main commit")
        return result.stdout
    guard.validate_main_ancestry(environment(RELEASE_SHA=first, WORKFLOW_REVISION=second), run)
    git("checkout", "-b", "unmerged")
    git("commit", "--allow-empty", "-m", "unmerged")
    with pytest.raises(ValueError, match="not a main commit"):
        guard.validate_main_ancestry(environment(RELEASE_SHA=git("rev-parse", "HEAD"), WORKFLOW_REVISION=second), run)
