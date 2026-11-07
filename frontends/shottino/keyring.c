/* keyring — see keyring.h. */
#include "keyring.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <openssl/crypto.h>

static const char *tool(void) {
    const char *t = getenv("SHOTTINO_SECRET_TOOL");
    return t && t[0] ? t : "secret-tool";
}

static long timeout_ms = KR_TIMEOUT_MS;

void kr_set_timeout_ms(long ms) { timeout_ms = ms; }

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* Runs the tool with `argv` (argv[0] set here), `in` on its stdin, up to
 * `out_cap` - 1 bytes of its stdout into `out` (NUL-terminated). True when
 * it ran and exited 0 within the deadline — the WHOLE run, the wait for its
 * exit included: one that closes its stdout and stays is killed. */
static bool run(const char **argv, const char *in, char *out, size_t out_cap) {
    int to_child[2], from_child[2];
    if (pipe(to_child) != 0) return false;
    if (pipe(from_child) != 0) {
        close(to_child[0]);
        close(to_child[1]);
        return false;
    }
    /* Close-on-exec: dup2 clears it on the copies the child keeps. */
    for (int i = 0; i < 2; i++) {
        fcntl(to_child[i], F_SETFD, FD_CLOEXEC);
        fcntl(from_child[i], F_SETFD, FD_CLOEXEC);
    }
    argv[0] = tool();
    pid_t pid = fork();
    if (pid == 0) {
        /* Only async-signal-safe calls until the exec: this process may
         * have other threads, whose locks the child does not own. */
        int null = open("/dev/null", O_WRONLY);
        dup2(to_child[0], STDIN_FILENO);
        dup2(from_child[1], STDOUT_FILENO);
        if (null >= 0) dup2(null, STDERR_FILENO);
        execvp(argv[0], (char *const *)argv);
        _exit(127);
    }
    close(to_child[0]);
    close(from_child[1]);
    if (pid < 0) {
        close(to_child[1]);
        close(from_child[0]);
        return false;
    }
    /* A secret's base64 is far below a pipe's buffer: this never blocks. */
    bool ok = true;
    if (in) {
        size_t n = strlen(in);
        ok = write(to_child[1], in, n) == (ssize_t)n;
    }
    close(to_child[1]);
    size_t len = 0;
    long deadline = now_ms() + timeout_ms;
    for (;;) {
        long left = deadline - now_ms();
        struct pollfd p = {.fd = from_child[0], .events = POLLIN};
        int r = left > 0 ? poll(&p, 1, (int)left) : 0;
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) {
            kill(pid, SIGKILL);
            ok = false;
            break;
        }
        char buf[256];
        ssize_t got = read(from_child[0], buf, sizeof(buf));
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) break;
        size_t take = (size_t)got < out_cap - 1 - len ? (size_t)got : out_cap - 1 - len;
        memcpy(out + len, buf, take);
        len += take;
        OPENSSL_cleanse(buf, sizeof(buf));
    }
    out[len] = 0;
    close(from_child[0]);
    int status = 0;
    for (;;) {
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid || (w < 0 && errno != EINTR)) break;
        if (now_ms() >= deadline) {
            kill(pid, SIGKILL);
            ok = false;
            while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
            break;
        }
        struct timespec nap = {0, 10 * 1000000L};
        nanosleep(&nap, NULL);
    }
    return ok && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

#define ATTRS(identity) "application", "shottino", "purpose", "e2e-data-key", "identity", identity

bool kr_lookup(const char *identity, uint8_t key[AR_KEY_LEN]) {
    const char *argv[] = {NULL, "lookup", ATTRS(identity), NULL};
    char out[128];
    bool ok = run(argv, NULL, out, sizeof(out));
    /* secret-tool ends the secret with a newline on a terminal only. */
    size_t n = strcspn(out, "\r\n");
    uint8_t *raw = NULL;
    size_t raw_len = 0;
    ok = ok && ar_unb64(out, n, &raw, &raw_len) && raw_len == AR_KEY_LEN;
    if (ok) memcpy(key, raw, AR_KEY_LEN);
    ar_free_secret(raw, raw_len);
    OPENSSL_cleanse(out, sizeof(out));
    return ok;
}

bool kr_store(const char *identity, const uint8_t key[AR_KEY_LEN]) {
    char label[160];
    snprintf(label, sizeof(label), "--label=shottino E2E data key (%s)", identity);
    const char *argv[] = {NULL, "store", label, ATTRS(identity), NULL};
    char *b64 = ar_b64(key, AR_KEY_LEN);
    char out[16];
    bool ok = run(argv, b64, out, sizeof(out));
    ar_free_secret(b64, strlen(b64));
    if (!ok) return false;
    uint8_t back[AR_KEY_LEN];
    ok = kr_lookup(identity, back) && CRYPTO_memcmp(back, key, AR_KEY_LEN) == 0;
    OPENSSL_cleanse(back, sizeof(back));
    return ok;
}
