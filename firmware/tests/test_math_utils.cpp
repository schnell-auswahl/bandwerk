#include <algorithm>
#include "dsp/math_utils.h"
#include "test_framework.h"

TEST(db_lin_roundtrip) {
  CHECK_NEAR(bm::DbToLin(0.0f), 1.0f, 1e-6);
  CHECK_NEAR(bm::DbToLin(-6.0206f), 0.5f, 1e-4);
  CHECK_NEAR(bm::DbToLin(20.0f), 10.0f, 1e-4);
  for (float db = -60.0f; db <= 12.0f; db += 6.0f) {
    CHECK_NEAR(bm::LinToDb(bm::DbToLin(db)), db, 1e-3);
  }
}

TEST(lin_to_db_floor) {
  CHECK_NEAR(bm::LinToDb(0.0f), bm::kDbFloor, 1e-6);
  CHECK_NEAR(bm::LinToDb(-1.0f), bm::kDbFloor, 1e-6);
}

TEST(clamp) {
  CHECK_NEAR(bm::Clamp(-1.0f, 0.0f, 1.0f), 0.0f, 0.0);
  CHECK_NEAR(bm::Clamp(2.0f, 0.0f, 1.0f), 1.0f, 0.0);
  CHECK_NEAR(bm::Clamp(0.4f, 0.0f, 1.0f), 0.4f, 0.0);
}

TEST(fast_db_matches_log10_within_a_few_thousandths_of_a_db) {
  double worst = 0.0;
  for (double x = 1.0e-9; x < 16.0; x *= 1.0007) {
    const double ref = 20.0 * log10(x);
    const double got = bm::FastDb(static_cast<float>(x));
    worst = std::max(worst, fabs(got - ref));
  }
  std::printf("    FastDb: worst error %.5f dB\n", worst);
  CHECK(worst < 0.005);
  CHECK_NEAR(bm::FastDb(1.0f), 0.0, 0.005);
  CHECK_NEAR(bm::FastDb(0.5f), -6.0206, 0.005);
  CHECK_NEAR(bm::FastDb(0.001f), -60.0, 0.005);
}

TEST(fast_db_is_monotonic) {
  float prev = -1.0e9f;
  for (double x = 1.0e-6; x < 4.0; x *= 1.001) {
    const float v = bm::FastDb(static_cast<float>(x));
    CHECK(v >= prev - 1e-4f);
    prev = v;
  }
}
