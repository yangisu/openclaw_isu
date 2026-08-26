#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

MODE="install"
PHASE="prepare"
case "${1:-}" in
  --dry-run) MODE="dry-run" ;;
  --check) MODE="check" ;;
  --finish) PHASE="finish" ;;
  "") ;;
  *) printf '%s\n' 'usage: install-openclaw.sh [--dry-run|--check|--finish]' >&2; exit 64 ;;
esac

EXPECTED_OPENCLAW="2026.7.1"
EXPECTED_UBUNTU="24.04"
MIN_NODE="24.15.0"
MAX_NODE="25.0.0"
CRON_EXPR='0 8-22 * * *'
CRON_TZ='Asia/Seoul'
CRON_MESSAGE='Call assistant_briefing once. Deliver only when send=true.'
CRON_KEY='openclaw-personal-assistant-hourly-briefing'
PLUGIN_ID='openclaw-personal-assistant'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
PLUGIN_ROOT="$REPO_ROOT/plugins/openclaw-personal-assistant"
CRON_TRIGGER="$SCRIPT_DIR/briefing-cron-trigger.js"
CRON_VALIDATOR="$SCRIPT_DIR/validate-cron-contract.js"
HARDENED_CONFIG_VALIDATOR="$SCRIPT_DIR/validate-hardened-config.js"
ACTIVE_CONFIG_PATH_VALIDATOR="$SCRIPT_DIR/validate-active-config-path.js"
RUNTIME_TOOLS_VALIDATOR="$SCRIPT_DIR/validate-runtime-tools.js"
OPENCLAW="$PLUGIN_ROOT/node_modules/.bin/openclaw"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
SECRET_DIR="$OPENCLAW_HOME/secrets"
CONFIG_TEMPLATE="$REPO_ROOT/config/openclaw.personal-assistant.example.json5"
CONFIG_FILE="$OPENCLAW_HOME/openclaw.personal-assistant.json5"
OPENCLAW_STATE_DIR="$OPENCLAW_HOME"
ACTIVE_CONFIG_FILE="$OPENCLAW_STATE_DIR/openclaw.json"
OPENCLAW_CONFIG_PATH="$ACTIVE_CONFIG_FILE"
export OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH

say() { printf '%s\n' "$*"; }
run() {
  if [[ "$MODE" == "dry-run" ]]; then printf 'DRY_RUN '; printf '%q ' "$@"; printf '\n'; else "$@"; fi
}

version_ge() {
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$2" ]]
}

validate_secret_tree() {
  [[ -d "$SECRET_DIR" && ! -L "$SECRET_DIR" ]] || { say 'secret_directory_invalid'; return 1; }
  local secret_root owner before after path canonical
  secret_root="$(readlink -f -- "$SECRET_DIR")"
  [[ "$secret_root" == "$SECRET_DIR" && "$(stat -c %a -- "$SECRET_DIR")" == 700 ]] \
    || { say 'secret_directory_permissions_invalid'; return 1; }
  owner="$(id -u)"
  [[ "$(stat -c %u -- "$SECRET_DIR")" == "$owner" ]] || { say 'secret_directory_owner_invalid'; return 1; }
  for file in telegram-token naver-caldav naver-oauth; do
    path="$SECRET_DIR/$file"
    [[ -e "$path" && ! -L "$path" ]] || { say "secret_file_invalid:$file"; return 1; }
    before="$(stat -Lc '%d:%i:%F:%u:%a' -- "$path")"
    canonical="$(readlink -f -- "$path")"
    after="$(stat -Lc '%d:%i:%F:%u:%a' -- "$path")"
    [[ "$before" == "$after" && "$canonical" == "$path" && "$(dirname -- "$canonical")" == "$secret_root"
      && "$before" == *':regular file:'"$owner"':600' ]] || { say "secret_file_invalid:$file"; return 1; }
  done
}

validate_config_file() {
  local path="$1" owner before after canonical
  [[ -e "$path" && ! -L "$path" ]] || { say 'config_file_invalid'; return 1; }
  owner="$(id -u)"
  before="$(stat -Lc '%d:%i:%F:%u:%a' -- "$path")"
  canonical="$(readlink -f -- "$path")"
  after="$(stat -Lc '%d:%i:%F:%u:%a' -- "$path")"
  [[ "$before" == "$after" && "$canonical" == "$path"
    && "$before" == *':regular file:'"$owner"':600' ]] || { say 'config_file_invalid'; return 1; }
}

validate_active_config_path() {
  local reported
  reported="$("$OPENCLAW" config file)" || { say 'active_config_path_unknown'; return 1; }
  printf '%s\n' "$reported" | node "$ACTIVE_CONFIG_PATH_VALIDATOR" "$ACTIVE_CONFIG_FILE" "$HOME" >/dev/null \
    || { say 'active_config_path_mismatch'; return 1; }
}

validate_runtime_tools() {
  local inspect_json
  inspect_json="$($OPENCLAW plugins inspect "$PLUGIN_ID" --runtime --json)"
  printf '%s' "$inspect_json" | node "$RUNTIME_TOOLS_VALIDATOR" >/dev/null \
    || { say 'runtime_tool_contract_invalid'; return 1; }
}

config_scalar() { "$OPENCLAW" config get "$1" --json | node -e 'let x="";process.stdin.on("data",c=>x+=c).on("end",()=>process.stdout.write(String(JSON.parse(x))))'; }
validate_active_config() {
  [[ "$(config_scalar gateway.bind)" == loopback
    && "$(config_scalar channels.telegram.dmPolicy)" == allowlist
    && "$(config_scalar channels.telegram.groupPolicy)" == disabled
    && "$(config_scalar channels.telegram.configWrites)" == false
    && "$(config_scalar commands.bash)" == false
    && "$(config_scalar commands.config)" == false
    && "$(config_scalar commands.mcp)" == false
    && "$(config_scalar commands.plugins)" == false
    && "$(config_scalar tools.elevated.enabled)" == false
    && "$(config_scalar cron.triggers.enabled)" == true
    && "$(config_scalar plugins.entries.openclaw-personal-assistant.enabled)" == true
    && "$(config_scalar plugins.entries.openclaw-personal-assistant.config.timezone)" == Asia/Seoul
    && "$(config_scalar channels.telegram.tokenFile)" == "$SECRET_DIR/telegram-token" ]] \
    || { say 'active_config_not_hardened'; return 1; }
  local configured_tools owner_id allow_from
  configured_tools="$($OPENCLAW config get tools.allow --json)"
  node -e 'const x=JSON.parse(process.argv[1]);const e=["assistant_briefing","assistant_calendar_confirm","assistant_calendar_prepare","assistant_mutate","assistant_query"];if(!Array.isArray(x)||JSON.stringify([...x].sort())!==JSON.stringify(e))process.exit(1)' "$configured_tools" \
    || { say 'configured_tool_contract_invalid'; return 1; }
  owner_id="$(config_scalar plugins.entries.openclaw-personal-assistant.config.telegramUserId)"
  [[ "$owner_id" =~ ^[1-9][0-9]{0,18}$ ]] || { say 'telegram_owner_id_invalid'; return 1; }
  allow_from="$($OPENCLAW config get channels.telegram.allowFrom --json)"
  node -e 'const x=JSON.parse(process.argv[1]);if(!Array.isArray(x)||x.length!==1||x[0]!==`tg:${process.argv[2]}`)process.exit(1)' "$allow_from" "$owner_id" \
    || { say 'telegram_allowlist_invalid'; return 1; }
}

validate_cron_contract() {
  local owner_id cron_json
  owner_id="$($OPENCLAW config get plugins.entries.openclaw-personal-assistant.config.telegramUserId | tr -d '"[:space:]')"
  [[ "$owner_id" =~ ^[1-9][0-9]{0,18}$ ]] || { say 'telegram_owner_id_invalid'; return 1; }
  cron_json="$($OPENCLAW cron list --all --json)"
  printf '%s' "$cron_json" | node "$CRON_VALIDATOR" "$CRON_TRIGGER" "$CRON_KEY" "$CRON_EXPR" "$CRON_MESSAGE" "$owner_id" \
    || { say 'cron_contract_invalid'; return 1; }
}

if [[ "$MODE" == "dry-run" ]]; then
  say "DRY_RUN verify Ubuntu $EXPECTED_UBUNTU, Node >=$MIN_NODE <$MAX_NODE, systemd, lingering"
  say "DRY_RUN verify package-local OpenClaw $EXPECTED_OPENCLAW"
  say "DRY_RUN build, validate, and inspect exact optional tools: assistant_briefing,assistant_calendar_confirm,assistant_calendar_prepare,assistant_mutate,assistant_query"
  say "DRY_RUN install owner-private token/config files and user systemd service"
  say "DRY_RUN declare exactly one Cron row: $CRON_EXPR $CRON_TZ staggerMs=0 isolated announce telegram owner"
  say 'DRY_RUN exact-hour trigger suppresses OpenClaw startup catch-up/replay'
  say "DRY_RUN message: $CRON_MESSAGE"
  say 'DRY_RUN no firewall, portproxy, listener, secret CLI argument, or external call'
  exit 0
fi

[[ -r /etc/os-release ]] || { say 'ubuntu_release_unknown'; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == "$EXPECTED_UBUNTU" ]] || { say 'ubuntu_release_incompatible'; exit 1; }
command -v node >/dev/null || { say 'node_missing'; exit 1; }
NODE_VERSION="$(node --version | sed 's/^v//')"
version_ge "$NODE_VERSION" "$MIN_NODE" && ! version_ge "$NODE_VERSION" "$MAX_NODE" || { say 'node_version_incompatible'; exit 1; }
[[ "$(ps -p 1 -o comm=)" == systemd ]] || { say 'systemd_not_pid1'; exit 1; }
loginctl show-user "$USER" -p Linger --value | grep -qx yes || {
  [[ "$MODE" == check ]] && { say 'linger_disabled'; exit 1; }
  run loginctl enable-linger "$USER"
}
[[ -x "$OPENCLAW" ]] || { say 'package_local_openclaw_missing'; exit 1; }
OPENCLAW_VERSION="$($OPENCLAW --version | sed -n 's/^OpenClaw \([^ ]*\).*/\1/p')"
[[ "$OPENCLAW_VERSION" == "$EXPECTED_OPENCLAW" ]] || { say 'openclaw_version_incompatible'; exit 1; }

if [[ "$MODE" == check ]]; then
  validate_secret_tree
  validate_config_file "$ACTIVE_CONFIG_FILE"
  validate_active_config_path
  node "$HARDENED_CONFIG_VALIDATOR" "$OPENCLAW" "$ACTIVE_CONFIG_FILE" "$SECRET_DIR"
  [[ -f "$PLUGIN_ROOT/dist/index.js" && ! -L "$PLUGIN_ROOT/dist/index.js" ]] || { say 'plugin_build_missing'; exit 1; }
  [[ -z "$(find "$PLUGIN_ROOT/src" -type f -newer "$PLUGIN_ROOT/dist/index.js" -print -quit)" ]] || { say 'plugin_build_stale'; exit 1; }
  npm --prefix "$PLUGIN_ROOT" run typecheck
  "$OPENCLAW" plugins validate --entry "$PLUGIN_ROOT/dist/index.js"
  validate_runtime_tools
  "$OPENCLAW" config validate
  validate_active_config
  systemctl --user is-enabled --quiet openclaw-gateway.service
  systemctl --user is-active --quiet openclaw-gateway.service
  validate_cron_contract
  say 'CHECK_OK'
  exit 0
fi

run mkdir -p -m 700 "$OPENCLAW_HOME" "$SECRET_DIR" "$OPENCLAW_HOME/workspace" "$OPENCLAW_HOME/state/openclaw-personal-assistant"
if [[ ! -e "$CONFIG_FILE" ]]; then run install -m 600 "$CONFIG_TEMPLATE" "$CONFIG_FILE"; fi

if [[ "$PHASE" == prepare ]]; then
  say 'STOP_INTERACTIVE: enter credentials locally; do not paste them into chat or command-line arguments.'
  say "install -m 600 /dev/stdin '$SECRET_DIR/telegram-token'"
  say "install -m 600 /dev/stdin '$SECRET_DIR/naver-caldav'"
  say "install -m 600 /dev/stdin '$SECRET_DIR/naver-oauth'"
  say "$OPENCLAW models auth login"
  say 'Complete Naver OAuth in the local browser, then rerun: install-openclaw.sh --finish'
  exit 2
fi

validate_secret_tree
validate_config_file "$CONFIG_FILE"
node "$HARDENED_CONFIG_VALIDATOR" "$OPENCLAW" "$CONFIG_FILE" "$SECRET_DIR"
"$OPENCLAW" config patch --file "$CONFIG_FILE" --dry-run --json >/dev/null

run npm --prefix "$PLUGIN_ROOT" ci
run npm --prefix "$PLUGIN_ROOT" run build
run "$OPENCLAW" plugins build --entry "$PLUGIN_ROOT/dist/index.js"
run "$OPENCLAW" plugins validate --entry "$PLUGIN_ROOT/dist/index.js"
run "$OPENCLAW" plugins install --link "$PLUGIN_ROOT"
run "$OPENCLAW" config patch --file "$CONFIG_FILE"
validate_config_file "$ACTIVE_CONFIG_FILE"
validate_active_config_path
node "$HARDENED_CONFIG_VALIDATOR" "$OPENCLAW" "$ACTIVE_CONFIG_FILE" "$SECRET_DIR"
run "$OPENCLAW" config validate
validate_active_config
OWNER_ID="$($OPENCLAW config get plugins.entries.openclaw-personal-assistant.config.telegramUserId | tr -d '"[:space:]')"
[[ "$OWNER_ID" =~ ^[1-9][0-9]{0,18}$ ]] || { say 'telegram_owner_id_invalid'; exit 1; }

validate_runtime_tools

run "$OPENCLAW" gateway install --force
run systemctl --user enable --now openclaw-gateway.service
run "$OPENCLAW" cron add --declaration-key "$CRON_KEY" --name 'Personal assistant hourly briefing' \
  --cron "$CRON_EXPR" --tz "$CRON_TZ" --exact --session isolated --message "$CRON_MESSAGE" \
  --trigger-script "$CRON_TRIGGER" --announce --channel telegram --to "$OWNER_ID" --json

validate_cron_contract

say 'INSTALL_OK'
