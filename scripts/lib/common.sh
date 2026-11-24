info()    { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
success() { printf '\033[1;32m[OK]\033[0m    %s\n' "$*"; }
die()     { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

prompt() {
    local var_name="$1"
    local prompt_text="$2"
    local default="${3:-}"
    local value

    if [[ -n "${!var_name:-}" ]]; then
        return
    fi

    if [[ "${NON_INTERACTIVE:-false}" == "true" ]]; then
        [[ -n "$default" ]] && printf -v "$var_name" '%s' "$default" && return
        die "Required variable '$var_name' not set and running non-interactively."
    fi

    local display_default=""
    [[ -n "$default" ]] && display_default=" [$default]"

    read -rp "${prompt_text}${display_default}: " value
    value="${value:-$default}"
    [[ -z "$value" ]] && die "'$var_name' cannot be empty."
    printf -v "$var_name" '%s' "$value"
}
