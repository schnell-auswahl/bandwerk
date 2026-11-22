#include "test_framework.h"
#include "ui/soft_takeover.h"

TEST(deadzone_ignores_small_jitter) {
  bm::KnobDeadzone dz(0.005f);
  CHECK_NEAR(dz.Process(0.500f), 0.500, 1e-6);
  CHECK_NEAR(dz.Process(0.503f), 0.500, 1e-6);  // inside dead zone
  CHECK_NEAR(dz.Process(0.497f), 0.500, 1e-6);
  CHECK_NEAR(dz.Process(0.510f), 0.510, 1e-6);  // moved enough
  CHECK_NEAR(dz.Process(0.508f), 0.510, 1e-6);
}

TEST(takeover_not_caught_far_away) {
  bm::SoftTakeover t;
  CHECK(!t.Update(0.9f, 0.3f));
  CHECK(!t.Update(0.8f, 0.3f));
  CHECK(!t.caught());
}

TEST(takeover_catches_inside_tolerance) {
  bm::SoftTakeover t;
  CHECK(!t.Update(0.9f, 0.3f));
  CHECK(!t.Update(0.5f, 0.3f));
  CHECK(t.Update(0.315f, 0.3f));  // within +-0.02
}

TEST(takeover_catches_immediately_if_already_close) {
  bm::SoftTakeover t;
  CHECK(t.Update(0.31f, 0.3f));
}

TEST(takeover_catches_on_crossing_even_if_fast) {
  bm::SoftTakeover t;
  CHECK(!t.Update(0.9f, 0.5f));
  CHECK(t.Update(0.1f, 0.5f));  // jumped over the stored value in one step
  CHECK(t.caught());
}

TEST(takeover_crossing_works_from_below) {
  bm::SoftTakeover t;
  CHECK(!t.Update(0.1f, 0.5f));
  CHECK(!t.Update(0.4f, 0.5f));
  CHECK(t.Update(0.7f, 0.5f));
}

TEST(takeover_stays_caught_and_reset_releases) {
  bm::SoftTakeover t;
  CHECK(t.Update(0.5f, 0.5f));
  CHECK(t.Update(0.9f, 0.5f));  // stays caught while turning away
  t.Reset();
  CHECK(!t.caught());
  CHECK(!t.Update(0.9f, 0.5f));
}
