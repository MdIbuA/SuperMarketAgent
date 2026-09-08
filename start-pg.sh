#!/bin/sh
set -e
echo "Setting up pg directories..."
mkdir -p /run/pgdata /run/postgresql
chown -R postgres:postgres /run/pgdata /run/postgresql
su - postgres -s /bin/sh -c "initdb -D /run/pgdata -U postgres --auth=trust"
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/g" /run/pgdata/postgresql.conf
echo "host all all 0.0.0.0/0 trust" >> /run/pgdata/pg_hba.conf
echo "host all all ::0/0 trust" >> /run/pgdata/pg_hba.conf
echo "Starting PostgreSQL..."
su - postgres -s /bin/sh -c "pg_ctl -D /run/pgdata -l /run/pgdata/pg.log start"
sleep 2
su - postgres -s /bin/sh -c "psql -U postgres -c 'CREATE DATABASE supermarket_agent;' || true"
echo "POSTGRESQL_READY"
tail -f /run/pgdata/pg.log
