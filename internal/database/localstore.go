package database

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/zalando/go-keyring"
	_ "modernc.org/sqlite"
)

const (
	keyringService = "hyperpg"
	keyringAccount = "local-connection-store-key-v1"
)

type storedConnection struct {
	Info        ConnectionInfo `json:"info"`
	DatabaseURL string         `json:"databaseUrl"`
}

// localConnectionStore keeps connection records in SQLite and encrypts each
// record with a key held by the operating system's credential store.
type localConnectionStore struct {
	db *sql.DB

	keyMu sync.Mutex
	key   []byte
}

func NewPostgresService() (*PostgresService, error) {
	store, err := openLocalConnectionStore()
	if err != nil {
		return nil, err
	}
	return &PostgresService{
		connections: make(map[string]*sql.DB),
		store:       store,
	}, nil
}

func openLocalConnectionStore() (*localConnectionStore, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("Could not find the user config directory: %w", err)
	}
	dataDir := filepath.Join(configDir, "hyperpg")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("Could not create the local data directory: %w", err)
	}

	db, err := sql.Open("sqlite", filepath.Join(dataDir, "connections.sqlite"))
	if err != nil {
		return nil, fmt.Errorf("Could not open the local connection database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		db.Close()
		return nil, fmt.Errorf("Could not configure the local connection database: %w", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS saved_connections (
		id TEXT PRIMARY KEY,
		data BLOB NOT NULL,
		last_used INTEGER NOT NULL
	)`); err != nil {
		db.Close()
		return nil, fmt.Errorf("Could not initialize the local connection database: %w", err)
	}
	return &localConnectionStore{db: db}, nil
}

func (s *localConnectionStore) encryptionKey() ([]byte, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	if len(s.key) != 0 {
		return s.key, nil
	}

	encoded, err := keyring.Get(keyringService, keyringAccount)
	if err == nil {
		key, decodeErr := base64.RawStdEncoding.DecodeString(encoded)
		if decodeErr != nil || len(key) != 32 {
			return nil, fmt.Errorf("The local encryption key in the system credential store is invalid")
		}
		s.key = key
		return s.key, nil
	}
	if !errors.Is(err, keyring.ErrNotFound) {
		return nil, fmt.Errorf("Could not access the system credential store")
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("Could not create a local encryption key")
	}
	if err := keyring.Set(keyringService, keyringAccount, base64.RawStdEncoding.EncodeToString(key)); err != nil {
		return nil, fmt.Errorf("Could not save a key to the system credential store")
	}
	s.key = key
	return s.key, nil
}

func (s *localConnectionStore) save(record storedConnection) error {
	key, err := s.encryptionKey()
	if err != nil {
		return err
	}
	plain, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("Could not encode the saved connection")
	}
	protected, err := encryptLocalRecord(key, []byte(record.Info.ID), plain)
	if err != nil {
		return fmt.Errorf("Could not encrypt the saved connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO saved_connections (id, data, last_used) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET data = excluded.data, last_used = excluded.last_used`,
		record.Info.ID, protected, time.Now().UnixNano())
	if err != nil {
		return fmt.Errorf("Could not save the local connection: %w", err)
	}
	return nil
}

func (s *localConnectionStore) list() ([]storedConnection, error) {
	key, err := s.encryptionKey()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := s.db.QueryContext(ctx, `SELECT id, data FROM saved_connections ORDER BY last_used DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("Could not read saved connections: %w", err)
	}
	defer rows.Close()

	connections := make([]storedConnection, 0)
	for rows.Next() {
		var id string
		var protected []byte
		if err := rows.Scan(&id, &protected); err != nil {
			return nil, fmt.Errorf("Could not read saved connections: %w", err)
		}
		plain, err := decryptLocalRecord(key, []byte(id), protected)
		if err != nil {
			return nil, fmt.Errorf("A saved connection could not be decrypted")
		}
		var record storedConnection
		if err := json.Unmarshal(plain, &record); err != nil || record.Info.ID != id || record.DatabaseURL == "" {
			return nil, fmt.Errorf("A saved connection record is invalid")
		}
		connections = append(connections, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("Could not read saved connections: %w", err)
	}
	return connections, nil
}

func (s *localConnectionStore) get(id string) (storedConnection, error) {
	key, err := s.encryptionKey()
	if err != nil {
		return storedConnection{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var protected []byte
	if err := s.db.QueryRowContext(ctx, `SELECT data FROM saved_connections WHERE id = ?`, id).Scan(&protected); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storedConnection{}, fmt.Errorf("That saved connection was removed")
		}
		return storedConnection{}, fmt.Errorf("Could not read the saved connection: %w", err)
	}
	plain, err := decryptLocalRecord(key, []byte(id), protected)
	if err != nil {
		return storedConnection{}, fmt.Errorf("The saved connection could not be decrypted")
	}
	var record storedConnection
	if err := json.Unmarshal(plain, &record); err != nil || record.Info.ID != id || record.DatabaseURL == "" {
		return storedConnection{}, fmt.Errorf("The saved connection record is invalid")
	}
	return record, nil
}

func (s *localConnectionStore) delete(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM saved_connections WHERE id = ?`, id); err != nil {
		return fmt.Errorf("Could not remove the saved connection: %w", err)
	}
	return nil
}

func (s *localConnectionStore) touch(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.db.ExecContext(ctx, `UPDATE saved_connections SET last_used = ? WHERE id = ?`, time.Now().UnixNano(), id)
}

func (s *localConnectionStore) close() error {
	return s.db.Close()
}

func encryptLocalRecord(key, associatedData, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(nonce, aead.Seal(nil, nonce, plain, associatedData)...), nil
}

func decryptLocalRecord(key, associatedData, protected []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(protected) < aead.NonceSize() {
		return nil, fmt.Errorf("invalid encrypted data")
	}
	nonce := protected[:aead.NonceSize()]
	return aead.Open(nil, nonce, protected[aead.NonceSize():], associatedData)
}
