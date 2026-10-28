#!/usr/bin/env python3
"""
Windows Worker Agent (`server.py`) for uni-mcp `computer_operation` Module
==========================================================================
Runs on Windows PC (Office: 192.168.0.91:8181 / Home: 100.107.229.43:8181)
Provides FastAPI HTTP endpoints backed by PyAutoGUI, MSS, Pillow, OpenCV/imageio,
and Windows process/power management utilities.

Dependencies (install on Windows PC):
    pip install fastapi uvicorn pyautogui mss pillow opencv-python numpy pydantic

Run on Windows PC (Port 8181):
    python server.py
"""

import base64
import io
import os
import platform
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import mss
import mss.tools
import pyautogui
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field

# Optional OpenCV + NumPy for MP4/AVI screen recording
try:
    import cv2
    import numpy as np

    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False

# Configure PyAutoGUI safety & responsiveness
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.05

WORKER_PORT = int(os.getenv("WORKER_PORT", "8181"))
WORKER_HOST = os.getenv("WORKER_HOST", "0.0.0.0")
WORKER_API_KEY = os.getenv("COMPUTER_API_KEY", "").strip()

OUTPUT_DIR = Path(os.getenv("WORKER_OUTPUT_DIR", str(Path.home() / "uni_mcp_captures")))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="uni-mcp Windows Computer Operation Worker",
    description="Remote GUI, Mouse, Keyboard, Screen, App & Power Automation Agent for uni-mcp",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_Methods=["*"],
    allow_headers=["*"],
)


def verify_api_key(x_api_key: Optional[str] = Header(default=None)):
    """Optional API Key authentication when COMPUTER_API_KEY is set on the worker."""
    if WORKER_API_KEY and x_api_key != WORKER_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header")


# ---------------------------------------------------------------------------
# Request Schemas
# ---------------------------------------------------------------------------


class MouseClickRequest(BaseModel):
    x: Optional[int] = None
    y: Optional[int] = None
    button: str = Field(default="left", description="left, right, or middle")
    clicks: int = Field(default=1, ge=1, le=10)
    interval: float = Field(default=0.1, ge=0.0, le=5.0)
    duration: float = Field(default=0.1, ge=0.0, le=10.0)


class MouseMoveRequest(BaseModel):
    x: int
    y: int
    duration: float = Field(default=0.2, ge=0.0, le=10.0)
    relative: bool = False


class MouseDragRequest(BaseModel):
    x: int
    y: int
    start_x: Optional[int] = None
    start_y: Optional[int] = None
    button: str = Field(default="left", description="left, right, or middle")
    duration: float = Field(default=0.5, ge=0.0, le=10.0)
    relative: bool = False


class MouseScrollRequest(BaseModel):
    clicks: int
    direction: str = Field(default="vertical", description="vertical or horizontal")
    x: Optional[int] = None
    y: Optional[int] = None


class ScreenshotRequest(BaseModel):
    monitor: int = Field(default=1, ge=0)
    format: str = Field(default="png", description="png or jpeg")
    quality: int = Field(default=85, ge=1, le=100)


class ScreenRecordRequest(BaseModel):
    duration: float = Field(default=5.0, ge=1.0, le=60.0)
    fps: int = Field(default=10, ge=1, le=30)
    monitor: int = Field(default=1, ge=0)
    return_base64: bool = False


class AppLaunchRequest(BaseModel):
    app: str
    args: List[str] = Field(default_factory=list)
    working_dir: Optional[str] = None


class AppKillRequest(BaseModel):
    process_name: Optional[str] = None
    pid: Optional[int] = None
    force: bool = True


class KeyboardTypeRequest(BaseModel):
    text: str
    interval: float = Field(default=0.02, ge=0.0, le=2.0)
    press_enter: bool = False


class KeyboardHotkeyRequest(BaseModel):
    keys: List[str]
    interval: float = Field(default=0.05, ge=0.0, le=2.0)


class PowerRequest(BaseModel):
    action: str = Field(description="shutdown, restart, or cancel")
    delay_seconds: int = Field(default=5, ge=0, le=3600)
    force: bool = True


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/status", dependencies=[Depends(verify_api_key)])
@app.get("/health", dependencies=[Depends(verify_api_key)])
def get_status():
    screen_width, screen_height = pyautogui.size()
    cursor_x, cursor_y = pyautogui.position()
    with mss.mss() as sct:
        monitors = sct.monitors

    return {
        "status": "ok",
        "hostname": platform.node(),
        "os": f"{platform.system()} {platform.release()} ({platform.version()})",
        "screen": {"width": screen_width, "height": screen_height},
        "cursor": {"x": cursor_x, "y": cursor_y},
        "monitors_count": max(len(monitors) - 1, 1),
        "opencv_available": HAS_OPENCV,
        "output_dir": str(OUTPUT_DIR),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


@app.post("/mouse/click", dependencies=[Depends(verify_api_key)])
def mouse_click(req: MouseClickRequest):
    btn = req.button.lower()
    if btn not in ("left", "right", "middle"):
        raise HTTPException(status_code=400, detail="button must be 'left', 'right', or 'middle'")

    if req.x is not None and req.y is not None:
        pyautogui.click(
            x=req.x,
            y=req.y,
            clicks=req.clicks,
            interval=req.interval,
            button=btn,
            duration=req.duration,
        )
    else:
        pyautogui.click(
            clicks=req.clicks,
            interval=req.interval,
            button=btn,
        )

    pos_x, pos_y = pyautogui.position()
    return {
        "status": "ok",
        "action": "mouse_click",
        "button": btn,
        "clicks": req.clicks,
        "cursor": {"x": pos_x, "y": pos_y},
    }


@app.post("/mouse/move", dependencies=[Depends(verify_api_key)])
def mouse_move(req: MouseMoveRequest):
    if req.relative:
        pyautogui.moveRel(req.x, req.y, duration=req.duration)
    else:
        pyautogui.moveTo(req.x, req.y, duration=req.duration)

    pos_x, pos_y = pyautogui.position()
    return {
        "status": "ok",
        "action": "mouse_move",
        "relative": req.relative,
        "cursor": {"x": pos_x, "y": pos_y},
    }


@app.post("/mouse/drag", dependencies=[Depends(verify_api_key)])
def mouse_drag(req: MouseDragRequest):
    btn = req.button.lower()
    if btn not in ("left", "right", "middle"):
        raise HTTPException(status_code=400, detail="button must be 'left', 'right', or 'middle'")

    if req.start_x is not None and req.start_y is not None:
        pyautogui.moveTo(req.start_x, req.start_y, duration=0.1)

    if req.relative:
        pyautogui.dragRel(req.x, req.y, duration=req.duration, button=btn)
    else:
        pyautogui.dragTo(req.x, req.y, duration=req.duration, button=btn)

    pos_x, pos_y = pyautogui.position()
    return {
        "status": "ok",
        "action": "mouse_drag",
        "button": btn,
        "relative": req.relative,
        "cursor": {"x": pos_x, "y": pos_y},
    }


@app.post("/mouse/scroll", dependencies=[Depends(verify_api_key)])
def mouse_scroll(req: MouseScrollRequest):
    direction = req.direction.lower()
    if direction == "horizontal":
        pyautogui.hscroll(req.clicks, x=req.x, y=req.y)
    else:
        pyautogui.scroll(req.clicks, x=req.x, y=req.y)

    pos_x, pos_y = pyautogui.position()
    return {
        "status": "ok",
        "action": "mouse_scroll",
        "direction": direction,
        "clicks": req.clicks,
        "cursor": {"x": pos_x, "y": pos_y},
    }


@app.post("/screen/screenshot", dependencies=[Depends(verify_api_key)])
def screen_screenshot(req: ScreenshotRequest):
    img_format = req.format.lower()
    if img_format not in ("png", "jpeg", "jpg"):
        raise HTTPException(status_code=400, detail="format must be 'png' or 'jpeg'")

    with mss.mss() as sct:
        monitor_idx = req.monitor if req.monitor < len(sct.monitors) else 1
        mon = sct.monitors[monitor_idx]
        sct_img = sct.grab(mon)
        pil_img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")

    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    ext = "jpg" if img_format in ("jpeg", "jpg") else "png"
    file_path = OUTPUT_DIR / f"screenshot_{timestamp_str}.{ext}"

    buf = io.BytesIO()
    if ext == "jpg":
        pil_img.save(buf, format="JPEG", quality=req.quality)
        pil_img.save(file_path, format="JPEG", quality=req.quality)
        mime_type = "image/jpeg"
    else:
        pil_img.save(buf, format="PNG")
        pil_img.save(file_path, format="PNG")
        mime_type = "image/png"

    b64_str = base64.b64encode(buf.getvalue()).decode("utf-8")

    return {
        "status": "ok",
        "action": "screenshot",
        "monitor": monitor_idx,
        "width": pil_img.width,
        "height": pil_img.height,
        "format": ext,
        "mime_type": mime_type,
        "saved_path": str(file_path),
        "size_bytes": len(buf.getvalue()),
        "base64_image": b64_str,
    }


@app.post("/screen/record", dependencies=[Depends(verify_api_key)])
def screen_record(req: ScreenRecordRequest):
    if not HAS_OPENCV:
        raise HTTPException(
            status_code=501,
            detail="opencv-python and numpy are required for screen recording. Install via: pip install opencv-python numpy",
        )

    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = OUTPUT_DIR / f"record_{timestamp_str}.mp4"

    with mss.mss() as sct:
        monitor_idx = req.monitor if req.monitor < len(sct.monitors) else 1
        mon = sct.monitors[monitor_idx]
        width = mon["width"]
        height = mon["height"]

        # Ensure even dimensions for mp4v codec compatibility
        width = width - (width % 2)
        height = height - (height % 2)

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(output_path), fourcc, float(req.fps), (width, height))

        frame_interval = 1.0 / float(req.fps)
        total_frames = int(req.duration * req.fps)
        captured_frames = 0
        start_time = time.perf_counter()

        try:
            for _ in range(total_frames):
                loop_start = time.perf_counter()
                sct_img = sct.grab(mon)
                frame = np.array(sct_img)
                frame_bgr = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
                if frame_bgr.shape[1] != width or frame_bgr.shape[0] != height:
                    frame_bgr = cv2.resize(frame_bgr, (width, height))
                writer.write(frame_bgr)
                captured_frames += 1

                elapsed = time.perf_counter() - loop_start
                sleep_for = frame_interval - elapsed
                if sleep_for > 0:
                    time.sleep(sleep_for)
        finally:
            writer.release()

    actual_duration = round(time.perf_counter() - start_time, 2)
    file_size = output_path.stat().st_size if output_path.exists() else 0

    response_data = {
        "status": "ok",
        "action": "screen_record",
        "monitor": monitor_idx,
        "width": width,
        "height": height,
        "fps": req.fps,
        "frames_captured": captured_frames,
        "duration_seconds": actual_duration,
        "saved_path": str(output_path),
        "size_bytes": file_size,
    }

    if req.return_base64 and output_path.exists():
        response_data["base64_video"] = base64.b64encode(output_path.read_bytes()).decode("utf-8")

    return response_data


@app.post("/app/launch", dependencies=[Depends(verify_api_key)])
def app_launch(req: AppLaunchRequest):
    app_target = req.app.strip()
    if not app_target:
        raise HTTPException(status_code=400, detail="'app' parameter cannot be empty")

    try:
        if platform.system() == "Windows" and not req.args and os.path.exists(app_target):
            os.startfile(app_target)
            return {
                "status": "ok",
                "action": "app_launch",
                "method": "os.startfile",
                "app": app_target,
            }

        cmd = [app_target] + list(req.args)
        proc = subprocess.Popen(
            cmd if len(req.args) > 0 else app_target,
            cwd=req.working_dir or None,
            shell=(len(req.args) == 0),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {
            "status": "ok",
            "action": "app_launch",
            "app": app_target,
            "args": req.args,
            "pid": proc.pid,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to launch '{app_target}': {exc}")


@app.post("/app/kill", dependencies=[Depends(verify_api_key)])
def app_kill(req: AppKillRequest):
    if not req.process_name and req.pid is None:
        raise HTTPException(status_code=400, detail="Either 'process_name' or 'pid' is required")

    if platform.system() == "Windows":
        cmd = ["taskkill"]
        if req.force:
            cmd.append("/F")
        if req.pid is not None:
            cmd.extend(["/PID", str(req.pid), "/T"])
        else:
            proc_name = req.process_name.strip()
            if not proc_name.lower().endswith(".exe"):
                proc_name += ".exe"
            cmd.extend(["/IM", proc_name, "/T"])
    else:
        cmd = ["kill", "-9" if req.force else "-15", str(req.pid)] if req.pid else ["pkill", "-f", req.process_name]

    result = subprocess.run(cmd, capture_output=True, text=True)
    return {
        "status": "ok" if result.returncode == 0 else "error",
        "action": "app_kill",
        "command": " ".join(cmd),
        "exit_code": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


@app.post("/keyboard/type", dependencies=[Depends(verify_api_key)])
def keyboard_type(req: KeyboardTypeRequest):
    pyautogui.write(req.text, interval=req.interval)
    if req.press_enter:
        pyautogui.press("enter")

    return {
        "status": "ok",
        "action": "keyboard_type",
        "length": len(req.text),
        "press_enter": req.press_enter,
    }


@app.post("/keyboard/hotkey", dependencies=[Depends(verify_api_key)])
def keyboard_hotkey(req: KeyboardHotkeyRequest):
    keys = [k.strip().lower() for k in req.keys if k.strip()]
    if not keys:
        raise HTTPException(status_code=400, detail="'keys' list cannot be empty")

    if len(keys) == 1:
        pyautogui.press(keys[0])
    else:
        pyautogui.hotkey(*keys, interval=req.interval)

    return {
        "status": "ok",
        "action": "keyboard_hotkey",
        "keys": keys,
    }


@app.post("/power", dependencies=[Depends(verify_api_key)])
def power_management(req: PowerRequest):
    action = req.action.strip().lower()
    if action not in ("shutdown", "restart", "cancel"):
        raise HTTPException(status_code=400, detail="action must be 'shutdown', 'restart', or 'cancel'")

    if platform.system() == "Windows":
        if action == "cancel":
            cmd = ["shutdown", "/a"]
        elif action == "shutdown":
            cmd = ["shutdown", "/s", "/t", str(req.delay_seconds)]
            if req.force:
                cmd.append("/f")
        else:  # restart
            cmd = ["shutdown", "/r", "/t", str(req.delay_seconds)]
            if req.force:
                cmd.append("/f")
    else:
        if action == "cancel":
            cmd = ["shutdown", "-c"]
        elif action == "shutdown":
            cmd = ["shutdown", "-h", f"+{max(req.delay_seconds // 60, 0)}"]
        else:
            cmd = ["shutdown", "-r", f"+{max(req.delay_seconds // 60, 0)}"]

    result = subprocess.run(cmd, capture_output=True, text=True)
    return {
        "status": "ok" if result.returncode == 0 else "error",
        "action": f"power_{action}",
        "command": " ".join(cmd),
        "delay_seconds": req.delay_seconds,
        "exit_code": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


if __name__ == "__main__":
    print("=================================================================")
    print(f"Starting uni-mcp Windows Worker Server on http://{WORKER_HOST}:{WORKER_PORT}")
    print(f"Captures Output Directory: {OUTPUT_DIR}")
    print("=================================================================")
    uvicorn.run(app, host=WORKER_HOST, port=WORKER_PORT)
