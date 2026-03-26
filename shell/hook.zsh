# curl-review shell hook for zsh
# Intercepts curl/wget install patterns (pipe-to-shell, process substitution)
# and rewrites them to curl-review for safe inspection.
#
# Source this file in your .zshrc:
#   source "$(npm root -g)/curl-review/shell/hook.zsh"
# Or if installed locally:
#   source /path/to/curl-review/shell/hook.zsh

# Guard against double-sourcing
(( $+functions[_curl_review_accept_line] )) && return

_curl_review_extract_url() {
  printf '%s' "$1" | grep -oE 'https?://[^ )"'"'"'|]+' | head -1
}

_curl_review_pipes_to_shell() {
  # Normalize whitespace around pipe for matching
  local cmd="${1//	/ }"  # tabs to spaces
  # Collapse multiple spaces
  while [[ "$cmd" = *'  '* ]]; do cmd="${cmd//  / }"; done
  # Match: | [sudo] [env] [/path/to/]sh|bash|zsh
  [[ "$cmd" = *'| sh'* ]] || \
  [[ "$cmd" = *'| bash'* ]] || \
  [[ "$cmd" = *'| zsh'* ]] || \
  [[ "$cmd" = *'| sudo sh'* ]] || \
  [[ "$cmd" = *'| sudo bash'* ]] || \
  [[ "$cmd" = *'| sudo zsh'* ]] || \
  [[ "$cmd" = *'| sudo env sh'* ]] || \
  [[ "$cmd" = *'| sudo env bash'* ]] || \
  [[ "$cmd" = *'| sudo env zsh'* ]] || \
  [[ "$cmd" = *'| env sh'* ]] || \
  [[ "$cmd" = *'| env bash'* ]] || \
  [[ "$cmd" = *'| env zsh'* ]] || \
  [[ "$cmd" = *'| /usr/bin/sh'* ]] || \
  [[ "$cmd" = *'| /usr/bin/bash'* ]] || \
  [[ "$cmd" = *'| /bin/sh'* ]] || \
  [[ "$cmd" = *'| /bin/bash'* ]] || \
  [[ "$cmd" = *'| /bin/zsh'* ]]
}

_curl_review_is_install_cmd() {
  # Normalize: collapse newlines (multi-line pastes) and tabs to spaces
  local cmd="${1//$'\n'/ }"
  cmd="${cmd//	/ }"

  # curl ... | sh/bash/zsh
  if [[ "$cmd" = *'curl '* ]] && _curl_review_pipes_to_shell "$cmd"; then
    return 0
  fi

  # wget ... | sh/bash/zsh
  if [[ "$cmd" = *'wget '* ]] && _curl_review_pipes_to_shell "$cmd"; then
    return 0
  fi

  # sh/bash/zsh <(curl ...)  (process substitution)
  if [[ "$cmd" = *sh*'<(curl '* || "$cmd" = *bash*'<(curl '* || "$cmd" = *zsh*'<(curl '* ]]; then
    return 0
  fi

  # bash -c "$(curl ...)" / sh -c "$(curl ...)"
  if [[ "$cmd" = *'-c'*'$(curl '* ]]; then
    return 0
  fi

  return 1
}

_curl_review_accept_line() {
  local cmd="$BUFFER"

  # Skip empty, comments, and already-rewritten commands
  if [[ -z "$cmd" || "$cmd" = '#'* || "$cmd" = *'curl-review'* ]]; then
    zle .accept-line
    return
  fi

  if _curl_review_is_install_cmd "$cmd"; then
    local url
    url=$(_curl_review_extract_url "$cmd")
    if [[ -n "$url" ]]; then
      zle -M "curl-review: intercepted install command -- press Enter to continue"
      BUFFER="curl-review ${(q)url} --original ${(q)cmd}"
      CURSOR=${#BUFFER}
      return
    fi
  fi

  zle .accept-line
}

zle -N accept-line _curl_review_accept_line
