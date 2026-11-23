// Frequency response of the pedal (OUT L against IN L) from noise, by Welch
// averaging: used to see the comb filter that a misaligned FX loop creates.
#pragma once

#include <complex>
#include <vector>

#include "test_rig.h"

namespace vt {

inline void Fft(std::vector<std::complex<double>>& a) {
  const size_t n = a.size();
  for (size_t i = 1, j = 0; i < n; ++i) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    const double ang = -2.0 * 3.14159265358979323846 / static_cast<double>(len);
    const std::complex<double> wl(std::cos(ang), std::sin(ang));
    for (size_t i = 0; i < n; i += len) {
      std::complex<double> w(1.0);
      for (size_t j = 0; j < len / 2; ++j) {
        const auto u = a[i + j], v = a[i + j + len / 2] * w;
        a[i + j] = u + v;
        a[i + j + len / 2] = u - v;
        w *= wl;
      }
    }
  }
}

struct Response {
  double bin_hz = 0.0;
  std::vector<double> mag_db;  // per bin
  // Magnitude in dB averaged over [f0, f1] Hz (power average).
  double BandDb(double f0, double f1) const {
    double s = 0.0;
    int n = 0;
    for (size_t k = 0; k < mag_db.size(); ++k) {
      const double f = static_cast<double>(k) * bin_hz;
      if (f >= f0 && f <= f1) {
        s += std::pow(10.0, mag_db[k] / 10.0);
        ++n;
      }
    }
    return n > 0 ? 10.0 * std::log10(s / n) : -999.0;
  }
  // Largest deviation (dB) of the 1/6-octave smoothed response from its mean
  // in [f0, f1]: how bumpy the response is.
  double MaxDip(double f0, double f1, double ref_db) const {
    double worst = 0.0;
    for (double f = f0; f < f1; f *= 1.1225) {  // 1/6 octave steps
      const double d = BandDb(f, f * 1.1225) - ref_db;
      if (std::fabs(d) > std::fabs(worst)) worst = d;
    }
    return worst;
  }
};

// Feeds `seconds` of noise (rms about 0.07) through the rig and measures the
// response of the output against the input (after `skip_s` of settling).
inline Response MeasureResponse(Rig& r, float seconds = 6.0f, float skip_s = 0.5f) {
  const int n = static_cast<int>(seconds * Rig::kSr);
  Noise noise(777);
  std::vector<float> in(n);
  for (float& x : in) x = 0.12f * noise.Next();
  std::vector<float> out(n);
  for (int i = 0; i < n; i += 128) {
    r.p->Process(in.data() + i, out.data() + i, n - i < 128 ? n - i : 128);
    r.Drain();
  }
  const int seg = 8192;
  std::vector<double> win(seg);
  for (int i = 0; i < seg; ++i) win[i] = 0.5 - 0.5 * std::cos(2.0 * 3.14159265358979323846 * i / seg);
  std::vector<double> pxx(seg / 2 + 1, 0.0);
  std::vector<std::complex<double>> pxy(seg / 2 + 1);
  for (int start = static_cast<int>(skip_s * Rig::kSr); start + seg <= n; start += seg / 2) {
    std::vector<std::complex<double>> x(seg), y(seg);
    for (int i = 0; i < seg; ++i) {
      x[i] = in[start + i] * win[i];
      y[i] = out[start + i] * win[i];
    }
    Fft(x);
    Fft(y);
    for (int k = 0; k <= seg / 2; ++k) {
      pxx[k] += std::norm(x[k]);
      pxy[k] += y[k] * std::conj(x[k]);
    }
  }
  Response resp;
  resp.bin_hz = static_cast<double>(Rig::kSr) / seg;
  resp.mag_db.resize(seg / 2 + 1);
  for (int k = 0; k <= seg / 2; ++k) resp.mag_db[k] = 20.0 * std::log10(std::abs(pxy[k]) / pxx[k] + 1e-12);
  return resp;
}

}  // namespace vt
