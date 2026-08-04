#!/usr/bin/env bats
#
# Bats suite for infra/cloud/check-drift.sh — the #665 shared-ground guard.
#
# The guard proves both provider doors (infra/aws/*.yaml today, infra/terraform/
# *.tf later) hand the shared first-boot.sh the SAME machine: they invoke it
# from their bootstrap block, they expose every knob in infra/cloud/params.contract,
# and they export exactly the env vars the bootstrap requires.
#
# EVERY drift case below is a mutation of the REAL, SHIPPED template (copied
# into a sandbox REPO_ROOT alongside the real params.contract and the real
# first-boot.sh). A synthetic door proves the guard rejects a shape we do not
# ship; only the real one proves it rejects the shape we do (#746).

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    GUARD="$REPO_SRC/infra/cloud/check-drift.sh"

    export GRAPPA_REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$GRAPPA_REPO_ROOT/infra/cloud" "$GRAPPA_REPO_ROOT/infra/aws"
    # The contract, the bootstrap and the door are all PRODUCTION copies, so
    # the knob set, the required-env set and the door shape under test are
    # truth rather than a re-typed approximation.
    cp "$REPO_SRC/infra/cloud/params.contract" "$GRAPPA_REPO_ROOT/infra/cloud/params.contract"
    cp "$REPO_SRC/infra/cloud/first-boot.sh" "$GRAPPA_REPO_ROOT/infra/cloud/first-boot.sh"

    BOOTSTRAP="$GRAPPA_REPO_ROOT/infra/cloud/first-boot.sh"
    AWS_DOOR="$GRAPPA_REPO_ROOT/infra/aws/grappa-cloudformation.yaml"
    REAL_AWS_DOOR="$REPO_SRC/infra/aws/grappa-cloudformation.yaml"
}

# The shipped CloudFormation door, verbatim.
write_real_aws_door() {
    cp "$REAL_AWS_DOOR" "$AWS_DOOR"
}

# Rewrite the sandbox door through a filter — every RED case is a one-mutation
# delta from the shipped template.
mutate_aws_door() {
    "$@" < "$AWS_DOOR" > "$AWS_DOOR.tmp"
    mv "$AWS_DOOR.tmp" "$AWS_DOOR"
}

write_real_tf_door() {
    mkdir -p "$GRAPPA_REPO_ROOT/infra/terraform"
    TF_DOOR="$GRAPPA_REPO_ROOT/infra/terraform/main.tf"
    cat > "$TF_DOOR" <<'EOF'
# grappa-knob: domain
variable "domain" { type = string }

# grappa-knob: admin_email
variable "admin_email" { type = string }

# grappa-knob: instance_type
variable "instance_type" { type = string }

# grappa-knob: ssh_cidr
variable "ssh_cidr" { type = string }

# grappa-knob: disk_size_gb
variable "disk_size_gb" { type = number }

resource "aws_instance" "grappa" {
  instance_type = var.instance_type
  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    export GRAPPA_DOMAIN='${var.domain}'
    export GRAPPA_ADMIN_EMAIL='${var.admin_email}'
    curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/cloud/first-boot.sh -o /root/grappa-first-boot.sh
    bash /root/grappa-first-boot.sh
  EOT
}
EOF
}

@test "GREEN: the shipped AWS door passes" {
    write_real_aws_door
    run "$GUARD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"bind all"* ]]
    [[ "$output" == *"export all"* ]]
}

@test "RED: deleting the bootstrap invocation fails even though prose still names it" {
    write_real_aws_door
    # Delete ONLY the executable bootstrap lines. The template still names
    # first-boot.sh in its Description and in three comments — the four prose
    # mentions that used to satisfy a whole-file grep (#746).
    mutate_aws_door grep -vE '^[[:space:]]*(curl|bash) .*first-boot'
    grep -q "first-boot.sh" "$AWS_DOOR" # the mutation is NOT "remove every trace"

    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not invoke first-boot.sh"* ]]
}

@test "RED: a knob marker orphaned by a deleted parameter fails" {
    write_real_aws_door
    # Delete the SshCidr parameter, leave its `# grappa-knob: ssh_cidr` marker.
    mutate_aws_door awk '/^[ ]*SshCidr:/ { skip = 1 } /grappa-knob:/ { skip = 0 } !skip'
    grep -q "grappa-knob: ssh_cidr" "$AWS_DOOR" # marker survives, parameter does not

    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"ssh_cidr"* ]]
}

@test "RED: a missing knob marker fails with exit 1" {
    write_real_aws_door
    mutate_aws_door grep -v "grappa-knob: ssh_cidr"
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"grappa-knob: ssh_cidr"* ]]
}

@test "RED: renaming an exported env var on the door side fails" {
    write_real_aws_door
    # The handshake break that kills every launched stack in UserData while
    # both files stay individually valid (#746).
    mutate_aws_door sed 's/GRAPPA_DOMAIN/GRAPPA_HOSTNAME/g'
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"GRAPPA_DOMAIN"* ]]
}

@test "RED: a new required env in first-boot.sh that no door exports fails" {
    write_real_aws_door
    # The same break from the other side: the bootstrap starts requiring a knob
    # the door never learned to pass.
    printf '%s\n' 'GRAPPA_REGION="${GRAPPA_REGION:-}"' >> "$BOOTSTRAP"
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"GRAPPA_REGION"* ]]
}

@test "RED: a door exporting an env var the bootstrap does not require fails" {
    write_real_aws_door
    mutate_aws_door awk '
        { print }
        /export GRAPPA_ADMIN_EMAIL=/ { print "          export GRAPPA_RAW_BASE=x" }
    '
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"GRAPPA_RAW_BASE"* ]]
}

@test "tolerant: absent infra/terraform is NOT drift" {
    write_real_aws_door
    # No infra/terraform/ dir exists in the sandbox.
    run "$GUARD"
    [ "$status" -eq 0 ]
}

@test "GREEN: a faithful Terraform door is also checked once present" {
    write_real_aws_door
    write_real_tf_door
    run "$GUARD"
    [ "$status" -eq 0 ]
}

@test "RED: a Terraform door missing a knob fails once present" {
    write_real_aws_door
    write_real_tf_door
    grep -v "grappa-knob: disk_size_gb" "$TF_DOOR" > "$TF_DOOR.tmp"
    mv "$TF_DOOR.tmp" "$TF_DOOR"
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"disk_size_gb"* ]]
}

@test "RED: a Terraform door whose user_data does not run the bootstrap fails" {
    write_real_aws_door
    write_real_tf_door
    grep -vE '^[[:space:]]*(curl|bash) .*first-boot' "$TF_DOOR" > "$TF_DOOR.tmp"
    mv "$TF_DOOR.tmp" "$TF_DOOR"
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not invoke first-boot.sh"* ]]
}

@test "RED: a door with no bootstrap block at all fails" {
    write_real_aws_door
    mutate_aws_door grep -v "UserData:"
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no UserData:/user_data bootstrap block"* ]]
}

@test "no doors at all is not a failure (exit 0)" {
    # No infra/aws door written.
    run "$GUARD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no provider doors"* ]]
}

@test "missing contract fails with exit 2 (misuse)" {
    write_real_aws_door
    rm "$GRAPPA_REPO_ROOT/infra/cloud/params.contract"
    run "$GUARD"
    [ "$status" -eq 2 ]
}

@test "missing first-boot.sh fails with exit 2 (misuse)" {
    write_real_aws_door
    rm "$BOOTSTRAP"
    run "$GUARD"
    [ "$status" -eq 2 ]
}

@test "the REAL repo passes its own guard" {
    unset GRAPPA_REPO_ROOT
    run "$GUARD"
    [ "$status" -eq 0 ]
}
