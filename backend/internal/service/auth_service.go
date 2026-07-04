package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"

	"bitbench/internal/config"
	"bitbench/internal/model"
	"bitbench/internal/repository"
)

var (
	ErrInvalidCredentials = errors.New("invalid email or password")
	ErrPasswordMismatch   = errors.New("current password is incorrect")
)

type AuthService struct {
	userRepo *repository.UserRepository
	rdb      *redis.Client
	cfg      *config.Config
}

func NewAuthService(userRepo *repository.UserRepository, rdb *redis.Client, cfg *config.Config) *AuthService {
	return &AuthService{userRepo: userRepo, rdb: rdb, cfg: cfg}
}

func (s *AuthService) Login(ctx context.Context, email, password string) (*model.LoginResponse, error) {
	user, err := s.userRepo.FindByEmail(ctx, email)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrInvalidCredentials
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, ErrInvalidCredentials
	}

	groupID := ""
	if user.GroupID != nil {
		groupID = user.GroupID.String()
	}

	token, err := model.GenerateToken(
		user.ID.String(),
		user.Email,
		user.Role,
		groupID,
		s.cfg.JWTExpiry,
	)
	if err != nil {
		return nil, err
	}

	s.userRepo.UpdateLastLogin(ctx, user.ID)

	return &model.LoginResponse{Token: token}, nil
}

func (s *AuthService) Logout(ctx context.Context, jti string, exp time.Time) error {
	ttl := time.Until(exp)
	if ttl <= 0 {
		return nil
	}
	return s.rdb.Set(ctx, "jwt_blocklist:"+jti, 1, ttl).Err()
}

func (s *AuthService) IsBlocked(ctx context.Context, jti string) (bool, error) {
	val, err := s.rdb.Exists(ctx, "jwt_blocklist:"+jti).Result()
	if err != nil {
		return false, err
	}
	return val > 0, nil
}

func (s *AuthService) ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return err
	}

	user, err := s.userRepo.FindByID(ctx, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrInvalidCredentials
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(currentPassword)); err != nil {
		return ErrPasswordMismatch
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.userRepo.UpdatePassword(ctx, uid, string(hash))
}

func (s *AuthService) GetUserProfile(ctx context.Context, userID string) (*model.User, error) {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return nil, err
	}
	return s.userRepo.FindByID(ctx, uid)
}
