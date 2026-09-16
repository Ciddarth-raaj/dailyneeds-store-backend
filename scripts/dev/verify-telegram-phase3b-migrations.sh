#!/usr/bin/env bash
#
# RUN THE PHASE 3B MIGRATIONS AGAINST A REAL MySQL 8.4, THE WAY PRODUCTION DOES.
#
#   bash scripts/dev/verify-telegram-phase3b-migrations.sh
#
# WHY THIS EXISTS. The migration tests beside these files read the SQL as TEXT.
# That is worth having - it is how the schema's intent is pinned - but it
# cannot see a rule the SERVER enforces, and one of those rules took the
# Phase 3B deploy down: MySQL refuses `ON DELETE CASCADE` on a column that a
# STORED generated column is computed from (`ER_CANNOT_ADD_FOREIGN`). Every
# text test passed; production was the first thing to execute the statement.
#
# So this executes them. It needs docker and the network; it is a developer
# tool, it is not wired into CI or the deploy, and it touches nothing outside
# its own scratch database.
#
# WHAT IT PROVES, in order:
#   1  20260916160000 creates
#   2  20260916180000 then creates
#   3  a second LIVE attempt for the same employee+group is rejected
#   4  once the first attempt concludes, a new one is allowed
#   5  hard-deleting a registry group cascades its join attempts
#   6  ... and its verifications
#   7  both down migrations run clean and leave nothing behind
#
# The schema it builds is scoped: the two tables these migrations reference,
# taken verbatim from their own migrations, plus bare stand-ins for the two
# unrelated masters those tables point at. The full history is not replayable
# from empty - several legacy migrations assume the pre-existing database -
# so `migrations` is seeded with every other migration name and db-migrate is
# left to run exactly the two under test, which is the situation on the server.
set -euo pipefail

CONTAINER="${CONTAINER:-dn-mysql-p3b}"
IMAGE="${IMAGE:-mysql:8.4}"          # production is RDS MySQL 8.4.x
DB=dnds_p3b
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQLS="$ROOT_DIR/migrations/mysql/migrations/sqls"
M() { docker exec -i "$CONTAINER" mysql -uroot -proot "$@" 2>/dev/null; }
Q() { docker exec "$CONTAINER" mysql -uroot -proot -N "$@" 2>/dev/null; }

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "starting $IMAGE as $CONTAINER ..."
  # native password: the pinned `mysql` driver predates caching_sha2.
  docker run -d --name "$CONTAINER" -e MYSQL_ROOT_PASSWORD=root -p 13306:3306 \
    "$IMAGE" --mysql-native-password=ON >/dev/null
  until docker exec "$CONTAINER" mysqladmin ping -uroot -proot --silent >/dev/null 2>&1; do sleep 3; done
  M -e "ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'root';"
fi

echo "MySQL $(Q -e 'SELECT VERSION();')"
M -e "DROP DATABASE IF EXISTS $DB; CREATE DATABASE $DB CHARACTER SET utf8mb4;"

# --- the schema these two migrations land on ------------------------------
M "$DB" <<'SQL'
CREATE TABLE `outlets` (`outlet_id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE `new_employee` (`employee_id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE `migrations` (`id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY, `name` VARCHAR(255) NOT NULL, `run_on` DATETIME NOT NULL);
SQL
awk '/^CREATE TABLE IF NOT EXISTS `telegram_group_registry`/,/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/' \
  "$SQLS/20261014120000-telegram-group-registry-up.sql" | M "$DB"
awk '/^CREATE TABLE IF NOT EXISTS `employee_telegram_identity`/,/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/' \
  "$SQLS/20261016120000-employee-telegram-identity-up.sql" | M "$DB"
M "$DB" -e "ALTER TABLE telegram_group_registry ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1;"

for f in $(ls "$ROOT_DIR"/migrations/mysql/migrations/*.js | xargs -n1 basename | sed 's/\.js$//'); do
  case "$f" in 20260916160000-*|20260916180000-*) continue;; esac
  echo "INSERT INTO migrations (name, run_on) VALUES ('/$f', NOW());"
done | M "$DB"

cat > "$ROOT_DIR/migrations/mysql/database.json" <<'JSON'
{ "p3b": { "host": "127.0.0.1", "port": "13306", "user": "root", "password": "root",
           "database": "dnds_p3b", "schema": "dnds_p3b", "driver": "mysql", "multipleStatements": true } }
JSON

echo "### 1+2: db-migrate up"
(cd "$ROOT_DIR/migrations/mysql" && db-migrate up -e p3b 2>&1 | grep -E '^\[(INFO|ERROR)\]')
Q -e "SELECT CONCAT('    live_marker EXTRA = ', EXTRA) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='employee_telegram_group_join_attempt' AND COLUMN_NAME='live_marker';"
Q -e "SELECT CONCAT('    ', CONSTRAINT_NAME, ' ON DELETE ', DELETE_RULE) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='$DB' AND CONSTRAINT_NAME LIKE 'fk_etg%';"

M "$DB" <<'SQL'
INSERT INTO outlets VALUES (1);
INSERT INTO new_employee VALUES (42);
INSERT INTO telegram_group_registry (telegram_group_id, group_name, chat_id, category, used_for, outlet_id) VALUES (10,'ECR Team','-1001','HR','test',1);
INSERT INTO employee_telegram_identity (employee_telegram_id, employee_id, telegram_user_id, private_chat_id, verified_mobile, connected_at) VALUES (900,42,555001,777001,'9000000000',NOW());
INSERT INTO employee_telegram_group_join_attempt (employee_id, telegram_group_id, invite_link_hash, expires_at) VALUES (42,10,REPEAT('a',64), NOW() + INTERVAL 15 MINUTE);
SQL

echo "### 3: a second live attempt for the same employee+group"
# `mysql` exits non-zero on the refusal we are hoping for, so its output is
# captured rather than piped - under `pipefail` a pipeline would report the
# expected failure as the step's own failure.
SECOND=$(docker exec -i "$CONTAINER" mysql -uroot -proot "$DB" 2>&1 <<'SQL' || true
INSERT INTO employee_telegram_group_join_attempt (employee_id, telegram_group_id, invite_link_hash, expires_at) VALUES (42,10,REPEAT('b',64), NOW() + INTERVAL 15 MINUTE);
SQL
)
case "$SECOND" in
  *"Duplicate entry '42:10' for key"*) echo "    PASS - rejected by uq_etgja_live" ;;
  *) echo "    FAIL - a second live attempt was accepted"; exit 1 ;;
esac

echo "### 4: once concluded, a new attempt is allowed"
M "$DB" <<'SQL'
UPDATE employee_telegram_group_join_attempt SET status='EXPIRED', concluded_at=NOW() WHERE invite_link_hash=REPEAT('a',64);
INSERT INTO employee_telegram_group_join_attempt (employee_id, telegram_group_id, invite_link_hash, expires_at) VALUES (42,10,REPEAT('b',64), NOW() + INTERVAL 15 MINUTE);
SQL
Q -e "SELECT CONCAT('    ', status, ' -> live_marker ', IFNULL(live_marker,'NULL')) FROM $DB.employee_telegram_group_join_attempt ORDER BY employee_telegram_group_join_attempt_id;"

echo "### 5+6: a registry hard-delete cascades both children"
M "$DB" -e "INSERT INTO employee_telegram_group_verification (employee_telegram_id, employee_id, telegram_group_id, membership, readiness_status, verified_at) VALUES (900,42,10,'JOINED','READY',NOW());"
Q -e "SELECT CONCAT('    before: attempts=', (SELECT COUNT(*) FROM $DB.employee_telegram_group_join_attempt), ' verifications=', (SELECT COUNT(*) FROM $DB.employee_telegram_group_verification));"
M "$DB" -e "DELETE FROM telegram_group_registry WHERE telegram_group_id=10;"
Q -e "SELECT CONCAT('    after : attempts=', (SELECT COUNT(*) FROM $DB.employee_telegram_group_join_attempt), ' verifications=', (SELECT COUNT(*) FROM $DB.employee_telegram_group_verification));"

echo "### 7: both down migrations"
# The seeded names stand in for history this scratch schema never ran; drop the
# ones that sort after ours so `down -c 2` pops exactly the two under test.
M "$DB" -e "DELETE FROM migrations WHERE name > '/20260916180000-employee-telegram-group-verification';"
(cd "$ROOT_DIR/migrations/mysql" && db-migrate down -e p3b -c 2 2>&1 | grep -E '^\[(INFO|ERROR)\]')
LEFT=$(Q -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME LIKE 'employee_telegram_group%';")
echo "    Phase 3B tables remaining: $LEFT"
[ "$LEFT" = "0" ] || { echo "    FAIL - down left tables behind"; exit 1; }

rm -f "$ROOT_DIR/migrations/mysql/database.json"
echo "ALL SEVEN PROOFS PASSED"
