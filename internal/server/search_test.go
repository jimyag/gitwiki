package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSearchRejectsInvalidFilters(t *testing.T) {
	for _, query := range []string{"draft=maybe", "updated_after=yesterday"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/search?"+query, nil)
		(&Server{}).searchPages(w, r, &call{})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d, want 400", query, w.Code)
		}
	}
}
