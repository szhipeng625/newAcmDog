#!/bin/bash
cd /home/admin/newAcmDog/server
set -a
source .env
set +a
exec node src/index.js
