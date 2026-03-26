# curl-review shell hook for fish
# Intercepts curl/wget install patterns (pipe-to-shell, process substitution)
# and rewrites them to curl-review for safe inspection.
#
# Copy to conf.d:
#   cp "$(npm root -g)/curl-review/shell/hook.fish" ~/.config/fish/conf.d/curl-review.fish

# Guard against double-sourcing
if set -q _CURL_REVIEW_HOOK_LOADED
    return
end
set -g _CURL_REVIEW_HOOK_LOADED 1

function _curl_review_extract_url
    printf '%s' $argv[1] | grep -oE 'https?://[^ )"|]+' | head -1
end

function _curl_review_is_install_cmd
    set -l cmd "$argv"

    # curl/wget ... | sh/bash/zsh (with optional sudo)
    if string match -qr 'curl\s' -- "$cmd"
        if string match -qr '\|\s*(sudo\s+)?(env\s+)?(/usr/bin/|/bin/)?(sh|bash|zsh)(\s|$)' -- "$cmd"
            return 0
        end
    end

    if string match -qr 'wget\s' -- "$cmd"
        if string match -qr '\|\s*(sudo\s+)?(env\s+)?(/usr/bin/|/bin/)?(sh|bash|zsh)(\s|$)' -- "$cmd"
            return 0
        end
    end

    # sh/bash/zsh <(curl ...) — fish doesn't support process substitution,
    # but users may paste commands intended for bash
    if string match -qr '(sh|bash|zsh)\s.*<\(curl\s' -- "$cmd"
        return 0
    end

    # sh/bash -c "$(curl ...)"
    if string match -qr '(sh|bash|zsh)\s+-c\s' -- "$cmd"
        if string match -q '*\$(curl *' -- "$cmd"
            return 0
        end
    end

    return 1
end

# Intercept Enter key. Inspects the command line before submission;
# rewrites install commands to curl-review. The user presses Enter
# again to execute the rewritten command.
function _curl_review_enter
    set -l cmd (commandline)

    # Skip empty, comments, and already-rewritten commands
    if test -z "$cmd"; or string match -q '#*' -- "$cmd"; or string match -q '*curl-review*' -- "$cmd"
        commandline -f execute
        return
    end

    if _curl_review_is_install_cmd "$cmd"
        set -l url (_curl_review_extract_url "$cmd")
        if test -n "$url"
            echo "curl-review: intercepted install command -- press Enter to continue"
            commandline -r "curl-review "(string escape -- $url)" --original "(string escape -- $cmd)
            return
        end
    end

    commandline -f execute
end

bind \r _curl_review_enter
bind \n _curl_review_enter
