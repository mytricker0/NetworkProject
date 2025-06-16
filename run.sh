#!/bin/bash

# Allow docker containers and root user to access X11
xhost +local:docker > /dev/null
xhost +local:root > /dev/null

# Check if DISPLAY is set to something like :0 or :1
if [[ -z "$DISPLAY" || "$DISPLAY" != :* ]]; then
    echo "⚠️  DISPLAY is not set correctly (current value: '$DISPLAY')."
    echo "❌ GUI verification won't work. You're out of luck for now 😕"
    echo "👉 Try running: export DISPLAY=:0 (or the correct display number)"
    sudo chown -R $USER:$USER i2pconfig

    exit 1
else
    echo "✅ DISPLAY is set to: $DISPLAY"
    echo "🚀 Launching Docker containers..."
    docker compose up --build
fi
