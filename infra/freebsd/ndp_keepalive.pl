#!/usr/local/bin/perl
#
# NDP keepalive supervisor (event-driven, process-accounting-friendly).
#
# Replaces the old spawn-per-tick shell loop, which fork+exec'd one
# short-lived `ping -c1` per (source, target) every PERIOD seconds. With a
# 13-address pool x (gateway + 2 anchors) that was ~39 process exits every 3s
# (~780/min). With kernel process accounting enabled the [accounting] kthread
# flushes every exit to ZFS and sits in D-state, inflating loadavg even though
# CPU/disk/mem are idle.
#
# Fix: one LONG-LIVED `ping -6 -i INTERVAL -S <src> <target>` per pair. The
# ping IS the data plane — it lives, emits one packet per INTERVAL, and never
# exits, so there are no process exits to account for. This perl process is
# only a babysitter: it reaps dead pings via SIGCHLD and respawns them, with a
# minimum-interval backoff so a pathological fast-dying ping (e.g. a source not
# yet assigned to the interface) cannot reintroduce a respawn fork-bomb.
#
# Why two target classes (unchanged from the old loop):
#   - GATEWAY (link-local, e.g. fe80::1%vtnet0): keeps the upstream router's
#     link-layer neighbour cache entry warm for each source address.
#   - EXTERNAL ANCHORS (global, e.g. 2606:4700:4700::1111): real end-to-end
#     round-trips that keep the upstream FORWARDING path warm for each global
#     source. Pinging only the link-local gateway does not exercise this.
#
# Invoked by ndp_keepalive.sh (the rc.d/daemon(8) entry point), which only
# exec's this script so the rc.d command and the daemon -r respawn layer stay
# unchanged. Configuration arrives via the same environment variables:
#   GRAPPA_ENV_FILE                  - grappa.env to read the pool from
#   GRAPPA_NDP_KEEPALIVE_INTERVAL    - seconds between packets per ping (-i)
#   GRAPPA_NDP_KEEPALIVE_GATEWAY     - pin gateway (required in shared-IP jails)
#   GRAPPA_NDP_KEEPALIVE_EXT_ANCHORS - comma-separated global v6 anchors
# (GRAPPA_NDP_KEEPALIVE_COUNT is obsolete here and ignored — pings are
# persistent, there are no per-tick bursts to size.)

use strict;
use warnings;
use POSIX qw(:sys_wait_h);

my $ENV_FILE     = $ENV{GRAPPA_ENV_FILE}                 // '/usr/local/etc/grappa/grappa.env';
my $INTERVAL     = $ENV{GRAPPA_NDP_KEEPALIVE_INTERVAL}   // 10;
my $GW_OVERRIDE  = $ENV{GRAPPA_NDP_KEEPALIVE_GATEWAY}    // '';
my $ANCHORS      = $ENV{GRAPPA_NDP_KEEPALIVE_EXT_ANCHORS}
                 // '2606:4700:4700::1111,2001:4860:4860::8888';

my $PING        = '/sbin/ping';
my $RESPAWN_MIN = 5;   # min seconds between respawns of the same pair

$INTERVAL = 10 unless $INTERVAL =~ /^\d+$/ && $INTERVAL >= 1;

sub log_msg { print "[ndp-keepalive] @_\n"; }

# pid => { src, target, key }   ;   key "src|target" => last-spawn epoch
my (%child, %last_spawn);
my $got_sigchld = 0;

sub spawn_pair {
	my ($src, $target) = @_;
	my $key = "$src|$target";
	my $pid = fork;
	if (!defined $pid) {
		log_msg "fork failed for $key: $! — will retry next sweep";
		return;
	}
	if ($pid == 0) {
		# child: become a persistent ping, output discarded
		open STDOUT, '>', '/dev/null';
		open STDERR, '>', '/dev/null';
		exec($PING, '-6', '-i', $INTERVAL, '-S', $src, $target)
			or POSIX::_exit(127);   # exec failed
	}
	$child{$pid} = { src => $src, target => $target, key => $key };
	$last_spawn{$key} = time;
}

sub reap_and_respawn {
	$got_sigchld = 0;
	my @dead;
	while ((my $pid = waitpid(-1, WNOHANG)) > 0) {
		my $info = delete $child{$pid} or next;
		push @dead, $info;
	}
	for my $info (@dead) {
		my $key   = $info->{key};
		my $since = time - ($last_spawn{$key} // 0);
		if ($since < $RESPAWN_MIN) {
			my $delay = $RESPAWN_MIN - $since;
			log_msg "ping $key died after ${since}s — backoff ${delay}s before respawn";
			sleep $delay;
		} else {
			log_msg "ping $key died — respawning";
		}
		spawn_pair($info->{src}, $info->{target});
	}
}

sub shutdown_all {
	log_msg "stopping — killing " . (scalar keys %child) . " ping children";
	kill 'TERM', keys %child if %child;
	# brief grace, then reap whatever is left
	sleep 1;
	while (waitpid(-1, WNOHANG) > 0) {}
	POSIX::_exit(0);
}

$SIG{CHLD} = sub { $got_sigchld = 1; };
$SIG{TERM} = \&shutdown_all;
$SIG{INT}  = \&shutdown_all;

# --- read the source pool from the env file (last assignment wins) ----------
open my $fh, '<', $ENV_FILE or do {
	log_msg "env file $ENV_FILE not readable — exiting";
	exit 1;
};
my $pool;
while (<$fh>) {
	$pool = $1 if /^GRAPPA_OUTBOUND_V6_POOL=(.*)$/;
}
close $fh;

unless (defined $pool && length $pool) {
	log_msg "GRAPPA_OUTBOUND_V6_POOL empty/missing in $ENV_FILE — nothing to keep alive, exiting";
	exit 0;
}

my @sources = grep { length } split /,/, $pool;
my @anchors = grep { length } split /,/, $ANCHORS;

# --- resolve gateway (override required in shared-IP jails) ------------------
sub resolve_gw {
	return $GW_OVERRIDE if length $GW_OVERRIDE;
	my $out = `route -6 -n get default 2>/dev/null`;
	return $1 if defined $out && $out =~ /gateway:\s*(\S+)/;
	return '';
}

my $gw;
until (length($gw = resolve_gw())) {
	log_msg "no default v6 gateway yet — retry in ${INTERVAL}s";
	sleep $INTERVAL;
}

my @targets = ($gw, @anchors);
log_msg "starting: interval=${INTERVAL}s gateway=$gw anchors=@anchors "
      . "sources=" . scalar(@sources) . " pairs=" . (scalar(@sources) * scalar(@targets));

for my $src (@sources) {
	for my $t (@targets) {
		spawn_pair($src, $t);
	}
}

# --- supervise: sleep is interrupted by SIGCHLD; the 60s backstop catches any
#     coalesced/missed signal so a dead ping never stays dead. ---------------
while (1) {
	sleep 60;
	reap_and_respawn();
}
