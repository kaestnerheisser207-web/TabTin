"""Workspace-authoritative runtime plane projection."""

from typing import Literal

RuntimePlane = Literal["local", "cloud"]


class UnsupportedExecutionDevice(ValueError):
    pass


def derive_runtime_plane(device_type: str) -> RuntimePlane:
    """Derive execution plane from the Workspace Device type.

    Agent configuration is deliberately not accepted by this function.
    """
    if device_type == "cloud":
        return "cloud"
    if device_type in {"electron", "daemon"}:
        return "local"
    raise UnsupportedExecutionDevice(
        f"Device type cannot host an Agent runtime: {device_type or '<empty>'}"
    )


def derive_workspace_runtime_plane(workspace) -> RuntimePlane:
    device = getattr(workspace, "device", None)
    return derive_runtime_plane(getattr(device, "device_type", ""))
